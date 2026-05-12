// Kit v4 API client.
//
// Auth: header `X-Kit-Api-Key: <token>`. Generate one at
//   Kit → Settings → Advanced → API Keys (the V4 key, not the legacy secret).
//
// Why v4 over v3:
//   - v3 broadcasts API mostly creates drafts; the actual "send" trigger is
//     ambiguous and was the failure mode in the original Manus build.
//   - v4 broadcasts can be created AND sent in one call by providing
//     `published_at` (immediate) or `send_at` (scheduled), with a
//     `subscriber_filter` to target a specific tag/segment.
//   - v4 has `POST /v4/bulk/tags/subscribers` for tagging hundreds of
//     subscribers in one round-trip — much faster than per-subscriber calls.
//
// Send strategy for each A/B half-batch:
//   1. Create a temp tag for the half (so subscriber_filter can target it).
//   2. Bulk-tag the chosen subscribers into it.
//   3. Create the broadcast with `subscriber_filter: [{all: [{type:'tag', ids:[temp_tag_id]}]}]`
//      and `send_at: <ISO now>` → Kit sends it.
//   4. Stats endpoint reports recipients + open_rate as the round progresses.

const KIT_BASE = 'https://api.kit.com/v4';

function requireKey(apiKey) {
  if (!apiKey) {
    const err = new Error('Kit v4 API key not set. Paste it in the Setup panel.');
    err.userFacing = true;
    throw err;
  }
}

async function kitFetch(method, path, apiKey, { query, body } = {}) {
  requireKey(apiKey);
  const qs = query ? '?' + new URLSearchParams(query) : '';
  const res = await fetch(`${KIT_BASE}${path}${qs}`, {
    method,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Kit-Api-Key': apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kit ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  // Some DELETE responses are empty
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function listTags(apiKey) {
  const data = await kitFetch('GET', '/tags', apiKey, { query: { per_page: 500 } });
  return (data.tags || []).map(t => ({ id: t.id, name: t.name }));
}

async function listSegments(apiKey) {
  try {
    const data = await kitFetch('GET', '/segments', apiKey, { query: { per_page: 500 } });
    return (data.segments || []).map(s => ({ id: s.id, name: s.name }));
  } catch (_e) {
    return [];
  }
}

async function tagSubscriberByEmail(apiKey, tagId, email) {
  return kitFetch('POST', `/tags/${tagId}/subscribers`, apiKey, {
    body: { email_address: email },
  });
}

async function createTag(apiKey, name) {
  const data = await kitFetch('POST', '/tags', apiKey, { body: { name } });
  const tag = data.tag || data;
  if (!tag.id) throw new Error('Kit createTag returned no id');
  return tag.id;
}

// Paginated fetch of all subscribers in a tag. v4 uses cursor-based
// pagination: response includes pagination.end_cursor + has_next_page.
//
// Note: segments are NOT supported. Kit v4 exposes `GET /v4/segments`
// to list saved segments, but there is no endpoint to enumerate the
// subscribers in a segment — segments are dynamic filters Kit resolves
// at broadcast send time. Since our A/B flow needs to split subscribers
// into halves, we can't use segments. Tags only.
async function fetchAllSubscribersForAudience(apiKey, audienceType, audienceId) {
  if (audienceType === 'segment') {
    const err = new Error('Kit v4 does not expose segment members via API. Create a tag in Kit (Subscribers → Tags → New), tag the people you want to test, and pick the tag here instead.');
    err.userFacing = true;
    throw err;
  }
  const out = [];
  let cursor;
  while (true) {
    const query = { per_page: 500 };
    if (cursor) query.after = cursor;
    const data = await kitFetch('GET', `/tags/${audienceId}/subscribers`, apiKey, { query });
    const batch = (data.subscribers || []).map(s => ({ id: s.id, email: s.email_address }));
    out.push(...batch);
    const next = data.pagination?.end_cursor && data.pagination?.has_next_page
      ? data.pagination.end_cursor : null;
    if (!next) break;
    cursor = next;
    if (out.length > 500_000) throw new Error('Pagination runaway (>500k subscribers)');
  }
  return out;
}

// Bulk-tag up to ~1000 subscribers in one call. Kit v4 accepts an array
// of {tag_id, subscriber_id} pairs.
async function bulkTagSubscribers(apiKey, tagId, subscribers) {
  if (!subscribers.length) return;
  const CHUNK = 1000;
  for (let i = 0; i < subscribers.length; i += CHUNK) {
    const slice = subscribers.slice(i, i + CHUNK);
    const taggings = slice.map(s => ({ tag_id: tagId, subscriber_id: s.id }));
    await kitFetch('POST', '/bulk/tags/subscribers', apiKey, { body: { taggings } });
  }
}

// Bulk-untag — same endpoint but DELETE. Best-effort cleanup.
async function bulkUntagSubscribers(apiKey, tagId, subscribers) {
  if (!subscribers.length) return;
  const CHUNK = 1000;
  for (let i = 0; i < subscribers.length; i += CHUNK) {
    const slice = subscribers.slice(i, i + CHUNK);
    const taggings = slice.map(s => ({ tag_id: tagId, subscriber_id: s.id }));
    try {
      await kitFetch('DELETE', '/bulk/tags/subscribers', apiKey, { body: { taggings } });
    } catch (_e) { /* best-effort */ }
  }
}

// Create AND send a broadcast targeting a single tag (the temp tag we just
// applied to the half-batch). Setting send_at to now triggers immediate send.
// Wrap the user's body in a max-width container so the email renders at a
// readable width inside Kit's template (which is otherwise full-width).
// Default 700px; pass maxWidth=0 to opt out.
function withMaxWidth(html, maxWidth) {
  if (!maxWidth || maxWidth <= 0) return html;
  return `<div style="max-width:${maxWidth}px;margin:0 auto;">${html}</div>`;
}

async function createAndSendBroadcast(apiKey, { subject, contentHtml, previewText, targetTagId, fromEmail, maxWidth = 700 }) {
  const nowIso = new Date().toISOString();
  const body = {
    subject,
    content: withMaxWidth(contentHtml, maxWidth),
    description: subject,
    public: false,
    published_at: nowIso,
    send_at: nowIso,
    subscriber_filter: [{ all: [{ type: 'tag', ids: [targetTagId] }] }],
  };
  if (previewText) body.preview_text = previewText;
  if (fromEmail) body.email_address = fromEmail;
  const data = await kitFetch('POST', '/broadcasts', apiKey, { body });
  const id = data.broadcast?.id ?? data.id;
  if (!id) throw new Error('Kit broadcast created but no id returned');
  return id;
}

// Test send — uses a "Test Recipient" tag we maintain just for previews.
async function createTestBroadcast(apiKey, { subject, contentHtml, previewText, testTagId, fromEmail }) {
  return createAndSendBroadcast(apiKey, {
    subject: `[TEST] ${subject}`,
    contentHtml,
    previewText,
    targetTagId: testTagId,
    fromEmail,
  });
}

async function listBroadcasts(apiKey, query = {}) {
  const out = [];
  let cursor;
  while (true) {
    const q = { per_page: 500, ...query };
    if (cursor) q.after = cursor;
    const data = await kitFetch('GET', '/broadcasts', apiKey, { query: q });
    out.push(...(data.broadcasts || []));
    const next = data.pagination?.end_cursor && data.pagination?.has_next_page
      ? data.pagination.end_cursor : null;
    if (!next) break;
    cursor = next;
    if (out.length > 100_000) break;
  }
  return out;
}

async function deleteBroadcast(apiKey, broadcastId) {
  return kitFetch('DELETE', `/broadcasts/${broadcastId}`, apiKey);
}

async function getBroadcastStats(apiKey, broadcastId) {
  const data = await kitFetch('GET', `/broadcasts/${broadcastId}/stats`, apiKey);
  const stats = data.broadcast?.stats || {};
  const opens = stats.emails_opened ?? 0;
  const recipients = stats.recipients ?? 0;
  // v4 returns open_rate as a percentage already (e.g. 23.4 means 23.4%)
  const openRate = typeof stats.open_rate === 'number'
    ? stats.open_rate
    : (recipients ? (opens / recipients) * 100 : 0);
  return { opens, recipients, openRate, status: stats.status, progress: stats.progress };
}

module.exports = {
  listTags,
  listSegments,
  createTag,
  tagSubscriberByEmail,
  fetchAllSubscribersForAudience,
  bulkTagSubscribers,
  bulkUntagSubscribers,
  createAndSendBroadcast,
  createTestBroadcast,
  listBroadcasts,
  deleteBroadcast,
  getBroadcastStats,
};
