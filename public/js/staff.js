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

function refreshRoundSummary() {
  const batch = Number(document.getElementById('batch_size').value) || defaults.batch_size;
  const wait = Number(document.getElementById('wait_minutes').value) || defaults.wait_minutes;
  const lineup = getLineup();
  const abRounds = Math.max(0, lineup.length - 1);
  const lineupNote = lineup.length
    ? `${lineup.length} subject${lineup.length === 1 ? '' : 's'} = ${abRounds} A/B round${abRounds === 1 ? '' : 's'}`
    : 'add subjects above';
  document.getElementById('lineup_summary').textContent = lineupNote;
  document.getElementById('round_summary').textContent =
    `Each round uses ${batch} people (split ${Math.ceil(batch/2)}/${Math.floor(batch/2)}). With ${abRounds} round${abRounds === 1 ? '' : 's'} × ${wait}min wait = ~${(abRounds * wait / 60).toFixed(1)} hours of wall time. Last batch and any remainder use the running winner.`;
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
        <thead><tr><th>Name</th><th>Status</th><th>Round</th><th>Current winner</th><th></th></tr></thead>
        <tbody>
          ${rows.map(c => `
            <tr>
              <td>${escapeHtml(c.name)}</td>
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
  try {
    const r = await fetch('/api/audience-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ include_tag_ids: include, exclude_tag_ids: exclude }),
    });
    const data = await r.json();
    if (!r.ok) {
      result.style.color = 'var(--bad)';
      result.textContent = `✗ ${data.error || 'Could not preview audience.'}`;
      return;
    }
    result.style.color = data.count ? 'var(--good)' : 'var(--warn)';
    result.textContent = `${data.count.toLocaleString()} subscriber${data.count === 1 ? '' : 's'} will receive this`;
  } catch (err) {
    result.style.color = 'var(--bad)';
    result.textContent = `✗ ${err.message}`;
  }
});

document.getElementById('batch_size').addEventListener('input', refreshRoundSummary);
document.getElementById('wait_minutes').addEventListener('input', refreshRoundSummary);
document.getElementById('subject_lineup').addEventListener('input', refreshRoundSummary);
document.getElementById('cleanup_tests_btn').addEventListener('click', async (e) => {
  e.preventDefault();
  const result = document.getElementById('cleanup_result');
  result.style.color = 'var(--muted)';
  result.textContent = 'Counting test broadcasts in Kit…';
  try {
    const r = await fetch('/api/test-broadcasts');
    const data = await r.json();
    if (!r.ok) {
      result.style.color = 'var(--bad)';
      result.textContent = `✗ ${data.error || 'Could not list broadcasts.'}`;
      return;
    }
    if (!data.count) {
      result.style.color = 'var(--muted)';
      result.textContent = 'No [TEST] broadcasts found.';
      return;
    }
    if (!confirm(`Found ${data.count} broadcast${data.count === 1 ? '' : 's'} with [TEST] in the subject.\n\nDelete all of them from Kit? This cannot be undone.`)) {
      result.style.color = 'var(--muted)';
      result.textContent = 'Cancelled.';
      return;
    }
    result.style.color = 'var(--muted)';
    result.textContent = `Deleting ${data.count}…`;
    const r2 = await fetch('/api/test-broadcasts', { method: 'DELETE' });
    const data2 = await r2.json();
    if (!r2.ok) {
      result.style.color = 'var(--bad)';
      result.textContent = `✗ ${data2.error || 'Cleanup failed.'}`;
      return;
    }
    result.style.color = 'var(--good)';
    result.textContent = `✓ Deleted ${data2.deleted}${data2.failed ? ` (${data2.failed} failed)` : ''}.`;
  } catch (err) {
    result.style.color = 'var(--bad)';
    result.textContent = `✗ ${err.message}`;
  }
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
  if (!subject || !email_html.trim() || !test_email) {
    result.style.color = 'var(--warn)';
    result.textContent = '✗ Need a subject, body, and email address.';
    return;
  }

  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  result.style.color = 'var(--muted)';
  result.textContent = 'Calling Kit API…';

  try {
    const r = await fetch('/api/test-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, email_html, test_email, preview_text }),
    });
    const data = await r.json();
    if (!r.ok) {
      result.style.color = 'var(--bad)';
      result.textContent = `✗ ${data.error || 'Test send failed.'}`;
      banner('error', data.error || 'Test send failed.', 8000);
    } else {
      result.style.color = 'var(--good)';
      result.textContent = `✓ Sent to ${test_email} (Kit broadcast id ${data.broadcast_id}). Check your inbox in 30–60s.`;
    }
  } catch (err) {
    result.style.color = 'var(--bad)';
    result.textContent = `✗ ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
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
  const payload = {
    name: document.getElementById('name').value.trim(),
    audience_include_tags: includeIds,
    audience_exclude_tags: excludeIds,
    audience_label: buildAudienceLabel(includeNames, excludeNames),
    subject_lineup: lineup,
    preview_text: document.getElementById('preview_text').value,
    email_html: quill.root.innerHTML,
    batch_size: document.getElementById('batch_size').value,
    wait_minutes: document.getElementById('wait_minutes').value,
  };
  if (!payload.name || !includeIds.length || lineup.length < 2 || !payload.email_html.trim()) {
    return banner('warn', 'Need a name, at least one include tag, at least 2 subject lines, and an email body.');
  }
  const summary = lineup.map((s, i) => `${i+1}. ${s}`).join('\n');
  if (!confirm(`Launch "${payload.name}" to:\n${payload.audience_label}\n\nWill test these ${lineup.length} subject lines head-to-head:\n${summary}\n\nThis will send real emails through your Kit account.`)) return;

  const r = await fetch('/api/campaigns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) return banner('error', data.error || 'Could not create campaign.', 6000);

  await fetch(`/api/campaigns/${data.id}/start`, { method: 'POST' });
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
