// Staff dashboard — setup panel + new campaign + list of past campaigns.

const quill = new Quill('#editor', {
  theme: 'snow',
  modules: {
    toolbar: [
      [{ header: [1, 2, 3, false] }],
      ['bold', 'italic', 'underline'],
      [{ list: 'ordered' }, { list: 'bullet' }],
      ['link', 'image'],
      ['clean'],
    ],
  },
  placeholder: 'Write the body of your email here. The same body is used for every round — only the subject line changes.',
});

let audiences = { tags: [], segments: [] };
let defaults = { batch_size: 1000, wait_minutes: 60, kit_configured: false, openai_configured: false };

function banner(kind, msg, ms = 4000) {
  const b = document.getElementById('banner');
  b.className = `banner ${kind}`;
  b.textContent = msg;
  b.style.display = 'block';
  if (ms) setTimeout(() => b.style.display = 'none', ms);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

// fetch() wrapper that survives empty / non-JSON response bodies. When
// Cloudflare cuts a connection past its 100s edge timeout, the browser sees
// an empty body that raw `await r.json()` chokes on with an opaque error.
// Returns { ok, status, data } where `data.error` is always a useful string
// when ok is false.
async function safeFetch(url, options) {
  let r;
  try {
    r = await fetch(url, options);
  } catch (err) {
    return { ok: false, status: 0, data: { error: `Network error: ${err.message}` } };
  }
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {
      error: text
        ? `Server returned ${r.status} with non-JSON body: ${text.slice(0, 200)}`
        : `Empty response (likely a Cloudflare 100s timeout — Kit may still be processing). Try again in 30 seconds.`,
    };
  }
  return { ok: r.ok, status: r.status, data };
}

function showSetup(show) {
  document.getElementById('setup_card').style.display = show ? '' : 'none';
}

async function loadConfig() {
  const r = await fetch('/api/config');
  const c = await r.json();
  document.getElementById('kit_api_key').placeholder = c.kit_api_key_set ? `set (${c.kit_api_key}) — paste new value to change` : 'not set';
  document.getElementById('openai_api_key').placeholder = c.openai_api_key_set ? `set (${c.openai_api_key}) — paste new value to change` : 'not set';
  document.getElementById('openai_model').value = c.openai_model || '';
  document.getElementById('default_batch_size').value = c.default_batch_size || '';
  document.getElementById('default_wait_minutes').value = c.default_wait_minutes || '';
  document.getElementById('ai_system_prompt').value = c.ai_system_prompt || '';
  return c;
}

document.getElementById('save_setup').addEventListener('click', async () => {
  const payload = {
    kit_api_key: document.getElementById('kit_api_key').value,
    openai_api_key: document.getElementById('openai_api_key').value,
    openai_model: document.getElementById('openai_model').value,
    default_batch_size: document.getElementById('default_batch_size').value,
    default_wait_minutes: document.getElementById('default_wait_minutes').value,
    ai_system_prompt: document.getElementById('ai_system_prompt').value,
  };
  const r = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (r.ok) {
    banner('ok', 'Saved.');
    document.getElementById('kit_api_key').value = '';
    document.getElementById('openai_api_key').value = '';
    await loadDefaults();
    await loadConfig();
    showSetup(!defaults.kit_configured || !defaults.openai_configured);
    if (defaults.kit_configured) loadAudiences();
  } else {
    banner('error', 'Save failed.');
  }
});

document.getElementById('toggle_setup').addEventListener('click', (e) => {
  e.preventDefault();
  const card = document.getElementById('setup_card');
  showSetup(card.style.display === 'none');
});

// ─── Campaign form ──────────────────────────────────────────────────────────

function renderAudienceOptions() {
  const inc = document.getElementById('include_tags');
  const exc = document.getElementById('exclude_tags');
  if (!audiences.tags.length) {
    inc.innerHTML = '<option value="">(no tags found in your Kit account)</option>';
    exc.innerHTML = '';
    return;
  }
  const opts = audiences.tags
    .map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`)
    .join('');
  inc.innerHTML = opts;
  exc.innerHTML = opts;
}

function getSelectedTagIds(selectId) {
  return Array.from(document.getElementById(selectId).selectedOptions).map(o => Number(o.value));
}

function getSelectedTagLabels(selectId) {
  return Array.from(document.getElementById(selectId).selectedOptions).map(o => o.textContent);
}

function buildAudienceLabel(includeNames, excludeNames) {
  let label = `Include: ${includeNames.join(', ')}`;
  if (excludeNames.length) label += ` · Exclude: ${excludeNames.join(', ')}`;
  return label;
}

function getLineup() {
  return document.getElementById('subject_lineup').value
    .split('\n').map(s => s.trim()).filter(Boolean);
}

function getCampaignType() {
  const r = document.querySelector('input[name="campaign_type"]:checked');
  return r ? r.value : 'sequential';
}

function refreshRoundSummary() {
  const batch = Number(document.getElementById('batch_size').value) || defaults.batch_size;
  const wait = Number(document.getElementById('wait_minutes').value) || defaults.wait_minutes;
  const lineup = getLineup();
  const type = getCampaignType();

  const hint = document.getElementById('subject_lineup_hint');
  if (type === 'tournament') {
    hint.textContent = 'tournament mode · need EXACTLY 5 subjects';
  } else {
    hint.textContent = 'one per line · at least 2 · winner moves up each round';
  }

  let abRounds, wallHours, lineupNote;
  if (type === 'tournament') {
    // 3 rounds total: SF (2 matches in parallel), Final, Title — each round = one wait window
    abRounds = lineup.length === 5 ? 3 : 0;
    const usedAudience = 4 * batch; // R1 uses 2 batches, R2 + R3 use 1 each
    wallHours = abRounds * wait / 60;
    lineupNote = lineup.length === 5
      ? `${lineup.length} subjects → bracket (SF1: S1 vs S2 ‖ SF2: S3 vs S4 → Final → vs S5) = 3 rounds, uses ~${usedAudience.toLocaleString()} people`
      : `tournament needs exactly 5 subjects (you have ${lineup.length})`;
  } else {
    abRounds = Math.max(0, lineup.length - 1);
    wallHours = abRounds * wait / 60;
    lineupNote = lineup.length
      ? `${lineup.length} subject${lineup.length === 1 ? '' : 's'} = ${abRounds} A/B round${abRounds === 1 ? '' : 's'}`
      : 'add subjects above';
  }
  document.getElementById('lineup_summary').textContent = lineupNote;
  document.getElementById('round_summary').textContent =
    `Each round uses ${batch} people (split ${Math.ceil(batch/2)}/${Math.floor(batch/2)}). ${abRounds} round${abRounds === 1 ? '' : 's'} × ${wait}min wait = ~${wallHours.toFixed(1)} hours wall time.`;
}

async function loadAudiences() {
  try {
    const r = await fetch('/api/audiences');
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      if (err.error === 'kit_not_configured') return;
      throw new Error(err.error || `HTTP ${r.status}`);
    }
    audiences = await r.json();
    renderAudienceOptions();
  } catch (err) {
    banner('error', `Could not load Kit audiences: ${err.message}`, 0);
  }
}

async function loadDefaults() {
  try {
    const r = await fetch('/api/defaults');
    if (r.ok) defaults = await r.json();
  } catch (_e) { /* keep hard defaults */ }
  document.getElementById('batch_size').placeholder = String(defaults.batch_size);
  document.getElementById('wait_minutes').placeholder = String(defaults.wait_minutes);
  refreshRoundSummary();
}

async function loadCampaigns() {
  const r = await fetch('/api/campaigns');
  if (!r.ok) {
    document.getElementById('campaigns_list').textContent = 'Could not load past campaigns.';
    return;
  }
  const rows = await r.json();
  document.getElementById('campaigns_list').innerHTML = !rows.length
    ? '<p class="muted small">No campaigns yet.</p>'
    : `<table>
        <thead><tr><th>Name</th><th>Mode</th><th>Status</th><th>Round</th><th>Current winner</th><th></th></tr></thead>
        <tbody>
          ${rows.map(c => `
            <tr>
              <td>${escapeHtml(c.name)}</td>
              <td><span class="muted small">${c.campaign_type === 'tournament' ? 'tournament' : 'sequential'}</span></td>
              <td><span class="pill ${c.status}">${c.status}</span></td>
              <td>${c.current_round} / ${c.total_rounds ?? '?'}</td>
              <td>${escapeHtml(c.current_winner || '')}</td>
              <td><a href="/campaigns/${c.id}">Open →</a></td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;
}

document.getElementById('preview_audience_btn').addEventListener('click', async () => {
  const result = document.getElementById('audience_preview_result');
  const include = getSelectedTagIds('include_tags');
  const exclude = getSelectedTagIds('exclude_tags');
  if (!include.length) {
    result.style.color = 'var(--warn)';
    result.textContent = '✗ Pick at least one include tag first.';
    return;
  }
  result.style.color = 'var(--muted)';
  result.textContent = 'Calling Kit to count subscribers…';
  const { ok, data } = await safeFetch('/api/audience-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ include_tag_ids: include, exclude_tag_ids: exclude }),
  });
  if (!ok) {
    result.style.color = 'var(--bad)';
    result.textContent = `✗ ${data.error || 'Could not preview audience.'}`;
    return;
  }
  result.style.color = data.count ? 'var(--good)' : 'var(--warn)';
  result.textContent = `${data.count.toLocaleString()} subscriber${data.count === 1 ? '' : 's'} will receive this`;
});

document.getElementById('batch_size').addEventListener('input', refreshRoundSummary);
document.getElementById('wait_minutes').addEventListener('input', refreshRoundSummary);
document.getElementById('subject_lineup').addEventListener('input', refreshRoundSummary);
document.querySelectorAll('input[name="campaign_type"]').forEach(r => r.addEventListener('change', refreshRoundSummary));
document.getElementById('cleanup_tests_btn').addEventListener('click', async (e) => {
  e.preventDefault();
  const result = document.getElementById('cleanup_result');
  result.style.color = 'var(--muted)';
  result.textContent = 'Counting test broadcasts in Kit…';
  const first = await safeFetch('/api/test-broadcasts');
  if (!first.ok) {
    result.style.color = 'var(--bad)';
    result.textContent = `✗ ${first.data.error || 'Could not list broadcasts.'}`;
    return;
  }
  if (!first.data.count) {
    result.style.color = 'var(--muted)';
    result.textContent = 'No [TEST] broadcasts found.';
    return;
  }
  if (!confirm(`Found ${first.data.count} broadcast${first.data.count === 1 ? '' : 's'} with [TEST] in the subject.\n\nWill attempt to delete via Kit API. Note: Kit's API doesn't allow deleting already-sent broadcasts (most test sends fall into that bucket), so a manual cleanup in Kit's UI may still be needed.`)) {
    result.style.color = 'var(--muted)';
    result.textContent = 'Cancelled.';
    return;
  }
  result.style.color = 'var(--muted)';
  result.textContent = `Working through ${first.data.count}…`;
  const second = await safeFetch('/api/test-broadcasts', { method: 'DELETE' });
  if (!second.ok) {
    result.style.color = 'var(--bad)';
    result.textContent = `✗ ${second.data.error || 'Cleanup failed.'}`;
    return;
  }
  const d2 = second.data;
  const parts = [];
  if (d2.deleted) parts.push(`✓ Deleted ${d2.deleted}`);
  if (d2.already_sent) parts.push(`⚠ ${d2.already_sent} already sent (Kit API won't delete these)`);
  if (d2.other_failed) parts.push(`✗ ${d2.other_failed} failed`);
  result.style.color = d2.already_sent && !d2.deleted ? 'var(--warn)' : 'var(--good)';
  result.innerHTML = parts.join(' · ') +
    (d2.already_sent ? ` — <a href="https://app.kit.com/broadcasts" target="_blank" rel="noopener">open Kit Broadcasts</a> to delete them manually.` : '');
});

document.getElementById('preview_text').addEventListener('input', () => {
  const v = document.getElementById('preview_text').value;
  const note = !v ? '' : v.length > 100 ? `${v.length} chars · may be truncated on mobile` : `${v.length} chars`;
  document.getElementById('preview_text_count').textContent = note;
});

document.getElementById('preview_btn').addEventListener('click', async () => {
  const lineup = getLineup();
  const subject = lineup[0] || '(no subject — add at least one in step 2)';
  const email_html = quill.root.innerHTML;
  const preview_text = document.getElementById('preview_text').value;
  const r = await fetch('/api/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject, email_html, preview_text }),
  });
  const html = await r.text();
  const w = window.open('', '_blank');
  w.document.open(); w.document.write(html); w.document.close();
});

document.getElementById('test_btn').addEventListener('click', async () => {
  const btn = document.getElementById('test_btn');
  const result = document.getElementById('test_result');

  const lineup = getLineup();
  const subject = lineup[0];
  const email_html = quill.root.innerHTML;
  const test_email = document.getElementById('test_email').value.trim();
  const preview_text = document.getElementById('preview_text').value;
  if (!subject || !email_html.trim()) {
    result.style.color = 'var(--warn)';
    result.textContent = '✗ Need a subject and a body before creating a draft.';
    return;
  }

  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Creating draft…';
  result.style.color = 'var(--muted)';
  result.textContent = 'Calling Kit API…';

  const { ok, data } = await safeFetch('/api/test-send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject, email_html, test_email, preview_text }),
  });
  if (!ok) {
    result.style.color = 'var(--bad)';
    result.textContent = `✗ ${data.error || 'Test send failed.'}`;
    banner('error', data.error || 'Test send failed.', 8000);
  } else {
    result.style.color = 'var(--good)';
    const target = test_email ? ` (suggested recipient: ${escapeHtml(test_email)})` : '';
    result.innerHTML = `✓ Draft #${data.broadcast_id} created. <a href="https://app.kit.com/broadcasts?status=draft" target="_blank" rel="noopener">Open Drafts in Kit</a> → click the [TEST] one → "Send test"${target}.`;
  }
  btn.disabled = false;
  btn.textContent = originalLabel;
});

document.getElementById('launch_btn').addEventListener('click', async () => {
  if (!defaults.kit_configured) {
    showSetup(true);
    return banner('warn', 'Save your Kit API key in the Setup panel before launching.');
  }
  const lineup = getLineup();
  const includeIds = getSelectedTagIds('include_tags');
  const excludeIds = getSelectedTagIds('exclude_tags');
  const includeNames = getSelectedTagLabels('include_tags');
  const excludeNames = getSelectedTagLabels('exclude_tags');
  const type = getCampaignType();
  const payload = {
    name: document.getElementById('name').value.trim(),
    campaign_type: type,
    audience_include_tags: includeIds,
    audience_exclude_tags: excludeIds,
    audience_label: buildAudienceLabel(includeNames, excludeNames),
    subject_lineup: lineup,
    preview_text: document.getElementById('preview_text').value,
    email_html: quill.root.innerHTML,
    batch_size: document.getElementById('batch_size').value,
    wait_minutes: document.getElementById('wait_minutes').value,
  };
  if (!payload.name || !includeIds.length || !payload.email_html.trim()) {
    return banner('warn', 'Need a name, at least one include tag, and an email body.');
  }
  if (type === 'tournament' && lineup.length !== 5) {
    return banner('warn', `Tournament mode requires exactly 5 subject lines (you have ${lineup.length}).`);
  }
  if (type === 'sequential' && lineup.length < 2) {
    return banner('warn', 'Sequential mode needs at least 2 subject lines.');
  }
  const summary = lineup.map((s, i) => `${i+1}. ${s}`).join('\n');
  const modeDesc = type === 'tournament'
    ? `Tournament bracket (SF1: S1 vs S2 ‖ SF2: S3 vs S4 → Final → vs S5)`
    : `${lineup.length} subjects head-to-head sequentially`;
  if (!confirm(`Launch "${payload.name}" to:\n${payload.audience_label}\n\n${modeDesc}:\n${summary}\n\nThis will send real emails through your Kit account.`)) return;

  const { ok, data } = await safeFetch('/api/campaigns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!ok) return banner('error', data.error || 'Could not create campaign.', 6000);

  await safeFetch(`/api/campaigns/${data.id}/start`, { method: 'POST' });
  location.href = `/campaigns/${data.id}`;
});

// ─── Boot ───────────────────────────────────────────────────────────────────

(async function init() {
  await loadDefaults();
  await loadConfig();
  showSetup(!defaults.kit_configured || !defaults.openai_configured);
  if (defaults.kit_configured) loadAudiences();
  loadCampaigns();
})();
