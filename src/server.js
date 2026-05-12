require('dotenv').config();

const path = require('path');
const express = require('express');

const { db, getSetting, setSetting, getAllSettings } = require('./db');
const kit = require('./kit-client');
const { generateChallengerSubject } = require('./openai-client');
const runner = require('./loop-runner');

const PORT = parseInt(process.env.PORT || '3000', 10);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Static + page routes ───────────────────────────────────────────────────

app.use('/static', express.static(path.join(__dirname, '..', 'public')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('/campaigns/:id', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'monitor.html'));
});

// ─── API: config (no auth — URL is the gate) ────────────────────────────────

const CONFIG_KEYS = [
  'kit_api_key',
  'openai_api_key',
  'openai_model',
  'ai_system_prompt',
  'default_batch_size',
  'default_wait_minutes',
];

const SECRET_KEYS = new Set(['kit_api_key', 'openai_api_key']);

app.get('/api/config', (_req, res) => {
  const all = getAllSettings();
  const out = {};
  for (const k of CONFIG_KEYS) {
    if (SECRET_KEYS.has(k)) {
      out[k] = all[k] ? '••••••••' + all[k].slice(-4) : '';
      out[`${k}_set`] = !!all[k];
    } else {
      out[k] = all[k] || '';
    }
  }
  res.json(out);
});

app.post('/api/config', (req, res) => {
  const body = req.body || {};
  for (const k of CONFIG_KEYS) {
    if (!(k in body)) continue;
    const v = body[k];
    if (SECRET_KEYS.has(k) && (!v || v.startsWith('••••'))) continue; // ignore masked
    setSetting(k, v);
  }
  res.json({ ok: true });
});

// Non-sensitive defaults for the campaign form
app.get('/api/defaults', (_req, res) => {
  res.json({
    batch_size: parseInt(getSetting('default_batch_size', '1000'), 10),
    wait_minutes: parseInt(getSetting('default_wait_minutes', '60'), 10),
    kit_configured: !!getSetting('kit_api_key'),
    openai_configured: !!getSetting('openai_api_key'), // optional; only used if user opts into AI mode
  });
});

// ─── API: Kit audience picker ───────────────────────────────────────────────

app.get('/api/audiences', async (_req, res) => {
  try {
    const kitKey = getSetting('kit_api_key');
    if (!kitKey) return res.status(400).json({ error: 'kit_not_configured' });
    const [tags, segments] = await Promise.all([
      kit.listTags(kitKey),
      kit.listSegments(kitKey),
    ]);
    res.json({ tags, segments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: campaigns ─────────────────────────────────────────────────────────

app.get('/api/campaigns', (_req, res) => {
  const rows = db.prepare(
    'SELECT id, name, status, current_round, total_rounds, current_winner, created_at FROM campaigns ORDER BY id DESC'
  ).all();
  res.json(rows);
});

app.get('/api/campaigns/:id', (req, res) => {
  const id = Number(req.params.id);
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  if (!campaign) return res.status(404).json({ error: 'not_found' });
  const rounds = db.prepare(
    'SELECT * FROM rounds WHERE campaign_id = ? ORDER BY round_number ASC'
  ).all(id);
  res.json({ campaign, rounds });
});

app.post('/api/campaigns', (req, res) => {
  const {
    name,
    audience_type,
    audience_id,
    audience_label,
    subject_lineup,        // array of subject strings (at least 2)
    preview_text,          // shared across all variations
    email_html,
    batch_size,
    wait_minutes,
  } = req.body || {};

  const lineup = Array.isArray(subject_lineup)
    ? subject_lineup.map(s => String(s || '').trim()).filter(Boolean)
    : [];

  if (!name || !audience_type || !audience_id || lineup.length < 2 || !email_html) {
    return res.status(400).json({ error: 'missing_fields', hint: 'Need at least 2 subject lines.' });
  }
  if (!['tag', 'segment'].includes(audience_type)) {
    return res.status(400).json({ error: 'bad_audience_type' });
  }

  const adminBatch = parseInt(getSetting('default_batch_size', '1000'), 10);
  const adminWait = parseInt(getSetting('default_wait_minutes', '60'), 10);
  const finalBatch = parseInt(batch_size, 10) || adminBatch;
  const finalWaitMin = parseInt(wait_minutes, 10) || adminWait;

  const ts = Date.now();
  const result = db.prepare(`
    INSERT INTO campaigns (
      name, audience_type, audience_id, audience_label,
      starting_subject, current_winner, subject_lineup, preview_text, email_html,
      batch_size, wait_seconds,
      status, created_at, updated_at
    ) VALUES (
      @name, @audience_type, @audience_id, @audience_label,
      @starting_subject, @starting_subject, @subject_lineup, @preview_text, @email_html,
      @batch_size, @wait_seconds,
      'draft', @ts, @ts
    )
  `).run({
    name, audience_type, audience_id,
    audience_label: audience_label || '',
    starting_subject: lineup[0],
    subject_lineup: JSON.stringify(lineup),
    preview_text: String(preview_text || '').trim(),
    email_html,
    batch_size: finalBatch,
    wait_seconds: finalWaitMin * 60,
    ts,
  });
  res.json({ id: result.lastInsertRowid });
});

app.post('/api/campaigns/:id/start', (req, res) => {
  try {
    runner.start(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns/:id/pause', (req, res) => {
  runner.pause(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/campaigns/:id/resume', (req, res) => {
  runner.resume(Number(req.params.id));
  res.json({ ok: true });
});

// ─── API: preview + test send ───────────────────────────────────────────────

app.post('/api/preview', (req, res) => {
  const { subject = '(no subject)', email_html = '', preview_text = '' } = req.body || {};
  const stripTags = s => String(s).replace(/[<>]/g, '');
  const safeSubject = stripTags(subject);
  const safePreview = stripTags(preview_text);
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Preview</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f5f7; margin: 0; padding: 24px; }
  .inbox { max-width: 640px; margin: 0 auto 16px; background: #fff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); padding: 12px 16px; }
  .inbox .from { font-weight: 600; font-size: 14px; color: #222; }
  .inbox .row { display: flex; gap: 6px; font-size: 14px; margin-top: 2px; }
  .inbox .subj { font-weight: 600; color: #1c1e21; }
  .inbox .pre { color: #65676b; }
  .inbox .pre::before { content: " — "; }
  .frame { max-width: 640px; margin: 0 auto; background: #fff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); overflow: hidden; }
  .meta { padding: 16px 20px; border-bottom: 1px solid #eee; }
  .meta .label { color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  .meta .from { color: #666; font-size: 13px; margin-top: 4px; }
  .meta .subject { font-size: 18px; font-weight: 600; margin-top: 4px; }
  .meta .preview { font-size: 13px; color: #65676b; margin-top: 4px; }
  .body { padding: 24px 20px; font-size: 15px; line-height: 1.55; color: #222; }
  .body img { max-width: 100%; height: auto; }
  h4 { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.04em; margin: 0 0 8px; max-width: 640px; margin-left: auto; margin-right: auto; }
</style></head>
<body>
  <h4>Inbox preview</h4>
  <div class="inbox">
    <div class="from">Your Sender Name</div>
    <div class="row">
      <span class="subj">${safeSubject}</span>${safePreview ? `<span class="pre">${safePreview}</span>` : ''}
    </div>
  </div>

  <h4>Opened email (rendered at 700px max-width, matches what subscribers will see)</h4>
  <div class="frame">
    <div class="meta">
      <div class="from">From: Your Sender Name &lt;you@example.com&gt;</div>
      <div class="subject">${safeSubject}</div>
      ${safePreview ? `<div class="preview">${safePreview}</div>` : ''}
    </div>
    <div class="body"><div style="max-width:700px;margin:0 auto;">${email_html}</div></div>
  </div>
</body></html>`);
});

app.post('/api/test-send', async (req, res) => {
  try {
    const { subject, email_html, test_email, preview_text } = req.body || {};
    if (!subject || !email_html || !test_email) {
      return res.status(400).json({ error: 'missing_fields' });
    }
    const kitKey = getSetting('kit_api_key');
    if (!kitKey) return res.status(400).json({ error: 'kit_not_configured' });

    let testTagId = getSetting('test_tag_id');
    if (!testTagId) {
      testTagId = await kit.createTag(kitKey, 'kit-ab-test-recipients');
      setSetting('test_tag_id', String(testTagId));
    }
    // v4: tag the test email (creates the subscriber if not already in Kit)
    await kit.tagSubscriberByEmail(kitKey, testTagId, test_email);
    // v4 broadcast send is immediate when send_at is now.
    const broadcastId = await kit.createTestBroadcast(kitKey, {
      subject,
      contentHtml: email_html,
      previewText: preview_text || '',
      testTagId,
    });
    res.json({ ok: true, broadcast_id: broadcastId, note: 'Test broadcast sent. Check your inbox.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Find and delete all broadcasts whose subject starts with "[TEST] ".
// Two-step: GET returns the count (so the UI can confirm), POST does the delete.
app.get('/api/test-broadcasts', async (_req, res) => {
  try {
    const kitKey = getSetting('kit_api_key');
    if (!kitKey) return res.status(400).json({ error: 'kit_not_configured' });
    const all = await kit.listBroadcasts(kitKey);
    const tests = all.filter(b => typeof b.subject === 'string' && b.subject.startsWith('[TEST] '));
    res.json({
      count: tests.length,
      sample: tests.slice(0, 5).map(t => ({ id: t.id, subject: t.subject })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/test-broadcasts', async (_req, res) => {
  try {
    const kitKey = getSetting('kit_api_key');
    if (!kitKey) return res.status(400).json({ error: 'kit_not_configured' });
    const all = await kit.listBroadcasts(kitKey);
    const tests = all.filter(b => typeof b.subject === 'string' && b.subject.startsWith('[TEST] '));
    let deleted = 0;
    let failed = 0;
    for (const t of tests) {
      try { await kit.deleteBroadcast(kitKey, t.id); deleted++; } catch (_e) { failed++; }
    }
    res.json({ ok: true, deleted, failed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Boot ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const resumed = runner.resumeAll();
  console.log(`Kit AB tester listening on http://localhost:${PORT}`);
  if (resumed) console.log(`Resumed ${resumed} running campaign(s) from prior boot`);
});
