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
  const type = document.getElementById('audience_type').value;
  const word = type === 'segment' ? 'segment' : 'tag';
  document.getElementById('audience_label_word').textContent = word;
  const select = document.getElementById('audience_id');
  const list = type === 'segment' ? audiences.segments : audiences.tags;
  if (!list.length) {
    select.innerHTML = `<option value="">(no ${word}s found in your Kit account)</option>`;
    return;
  }
  select.innerHTML = list.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
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

document.getElementById('audience_type').addEventListener('change', renderAudienceOptions);
document.getElementById('batch_size').addEventListener('input', refreshRoundSummary);
document.getElementById('wait_minutes').addEventListener('input', refreshRoundSummary);
document.getElementById('subject_lineup').addEventListener('input', refreshRoundSummary);
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
  const lineup = getLineup();
  const subject = lineup[0];
  const email_html = quill.root.innerHTML;
  const test_email = document.getElementById('test_email').value.trim();
  const preview_text = document.getElementById('preview_text').value;
  if (!subject || !email_html.trim() || !test_email) {
    return banner('warn', 'Need at least one subject line, an email body, and an address to test to.');
  }
  const r = await fetch('/api/test-send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject, email_html, test_email, preview_text }),
  });
  const data = await r.json();
  if (!r.ok) return banner('error', data.error || 'Test send failed.', 6000);
  banner('ok', `Test broadcast created in Kit (id ${data.broadcast_id}). ${data.note || ''}`, 8000);
});

document.getElementById('launch_btn').addEventListener('click', async () => {
  if (!defaults.kit_configured) {
    showSetup(true);
    return banner('warn', 'Save your Kit API key in the Setup panel before launching.');
  }
  const lineup = getLineup();
  const payload = {
    name: document.getElementById('name').value.trim(),
    audience_type: document.getElementById('audience_type').value,
    audience_id: document.getElementById('audience_id').value,
    audience_label: document.getElementById('audience_id').selectedOptions[0]?.textContent || '',
    subject_lineup: lineup,
    preview_text: document.getElementById('preview_text').value,
    email_html: quill.root.innerHTML,
    batch_size: document.getElementById('batch_size').value,
    wait_minutes: document.getElementById('wait_minutes').value,
  };
  if (!payload.name || !payload.audience_id || lineup.length < 2 || !payload.email_html.trim()) {
    return banner('warn', 'Need a name, an audience, at least 2 subject lines, and an email body.');
  }
  const summary = lineup.map((s, i) => `${i+1}. ${s}`).join('\n');
  if (!confirm(`Launch "${payload.name}" to ${payload.audience_label}?\n\nWill test these ${lineup.length} subject lines head-to-head:\n${summary}\n\nThis will send real emails through your Kit account.`)) return;

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
