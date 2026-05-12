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
  'kit_api_secret',
  'openai_api_key',
  'openai_model',
  'ai_system_prompt',
  'default_batch_size',
  'default_wait_minutes',
];

const SECRET_KEYS = new Set(['kit_api_secret', 'openai_api_key']);

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
    kit_configured: !!getSetting('kit_api_secret'),
    openai_configured: !!getSetting('openai_api_key'),
  });
});

// ─── API: Kit audience picker ───────────────────────────────────────────────

app.get('/api/audiences', async (_req, res) => {
  try {
    const kitKey = getSetting('kit_api_secret');
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
    starting_subject,
    email_html,
    batch_size,
    wait_minutes,
  } = req.body || {};

  if (!name || !audience_type || !audience_id || !starting_subject || !email_html) {
    return res.status(400).json({ error: 'missing_fields' });
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
      starting_subject, current_winner, email_html,
      batch_size, wait_seconds,
      status, created_at, updated_at
    ) VALUES (
      @name, @audience_type, @audience_id, @audience_label,
      @starting_subject, @starting_subject, @email_html,
      @batch_size, @wait_seconds,
      'draft', @ts, @ts
    )
  `).run({
    name, audience_type, audience_id,
    audience_label: audience_label || '',
    starting_subject, email_html,
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
  const { subject = '(no subject)', email_html = '' } = req.body || {};
  const safeSubject = String(subject).replace(/[<>]/g, '');
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Preview</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f5f7; margin: 0; padding: 24px; }
  .frame { max-width: 640px; margin: 0 auto; background: #fff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); overflow: hidden; }
  .meta { padding: 16px 20px; border-bottom: 1px solid #eee; }
  .meta .from { color: #666; font-size: 13px; }
  .meta .subject { font-size: 18px; font-weight: 600; margin-top: 4px; }
  .body { padding: 24px 20px; font-size: 15px; line-height: 1.55; color: #222; }
  .body img { max-width: 100%; height: auto; }
</style></head>
<body>
  <div class="frame">
    <div class="meta">
      <div class="from">From: Your Sender Name &lt;you@example.com&gt;</div>
      <div class="subject">${safeSubject}</div>
    </div>
    <div class="body">${email_html}</div>
  </div>
</body></html>`);
});

app.post('/api/test-send', async (req, res) => {
  try {
    const { subject, email_html, test_email } = req.body || {};
    if (!subject || !email_html || !test_email) {
      return res.status(400).json({ error: 'missing_fields' });
    }
    const kitKey = getSetting('kit_api_secret');
    if (!kitKey) return res.status(400).json({ error: 'kit_not_configured' });

    let testTagId = getSetting('test_tag_id');
    if (!testTagId) {
      testTagId = await kit.createTag(kitKey, 'kit-ab-test-recipients');
      setSetting('test_tag_id', testTagId);
    }
    await kit.tagSubscriber(kitKey, testTagId, test_email);
    const broadcastId = await kit.createBroadcast(kitKey, {
      subject: `[TEST] ${subject}`,
      contentHtml: email_html,
    });
    res.json({ ok: true, broadcast_id: broadcastId, note: 'Broadcast created in Kit. If your account doesn\'t auto-send drafts, publish it from the Kit UI.' });
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
