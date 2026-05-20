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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  if (/^\d+$/.test(headerValue.trim())) return parseInt(headerValue, 10) * 1000;
  const t = Date.parse(headerValue);
  if (!Number.isNaN(t)) return Math.max(0, t - Date.now());
  return null;
}

async function kitFetch(method, path, apiKey, { query, body, maxBackoffBudgetMs = 60_000 } = {}) {
  requireKey(apiKey);
  const qs = query ? '?' + new URLSearchParams(query) : '';
  const url = `${KIT_BASE}${path}${qs}`;
  const init = {
    method,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Kit-Api-Key': apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  };
  // We retry on 429 with a backoff that's >= Kit's per-minute window,
  // but cap the TOTAL accumulated backoff so the request returns inside
  // Cloudflare's 100s edge timeout for user-facing routes. Background
  // callers (tag/untag loops) pass a larger budget.
  let totalBackoff = 0;
  const MAX_ATTEMPTS = 6;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, init);
    if (res.status === 429) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      const backoff = retryAfter ?? (65_000 + attempt * 5_000 + Math.floor(Math.random() * 1000));
      if (attempt === MAX_ATTEMPTS || totalBackoff + backoff > maxBackoffBudgetMs) {
        throw new Error(`Kit ${method} ${path} → 429 (rate limited; gave up after ${(totalBackoff/1000).toFixed(0)}s of backoff)`);
      }
      totalBackoff += backoff;
      await sleep(backoff);
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Kit ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }
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
  // Force to string for the same reason — TEXT-column safety.
  return String(tag.id);
}

// Fetch all subscribers in a single tag. WARNING: Kit v4's
// GET /v4/tags/{id}/subscribers has a hard ~2000-record cap regardless of
// pagination params, status filter, or sort order. For tags with more than
// 2000 active subscribers this returns INCOMPLETE results. Use
// fetchAudienceByTagSelection instead, which works around the cap by
// pulling /v4/subscribers (uncapped) and filtering client-side.
async function fetchSubscribersInTag(apiKey, tagId) {
  const out = [];
  let cursor;
  while (true) {
    const query = { per_page: 1000 };
    if (cursor) query.after = cursor;
    const data = await kitFetch('GET', `/tags/${tagId}/subscribers`, apiKey, { query });
    for (const s of (data.subscribers || [])) out.push({ id: s.id, email: s.email_address });
    cursor = data.pagination?.has_next_page ? data.pagination.end_cursor : null;
    if (!cursor) break;
  }
  return out;
}

// In-memory cache for fetchAllSubscribersWithTags. The full /v4/subscribers
// paginate can take 13-100+ seconds (Kit's 429 backoffs inject ≥65s pauses
// mid-fetch), which risks Cloudflare's 100s edge timeout for any caller
// going through the tunnel. Caching lets the second+ preview return instantly
// and lets the loop runner skip refetching every round.
//
// TTL is short on purpose — long enough to absorb burst preview clicks and a
// few campaign rounds, short enough that mid-campaign subscriber additions
// catch up within ~5 minutes.
const SUBS_CACHE = { key: null, at: 0, subs: null };
const SUBS_CACHE_TTL_MS = 5 * 60 * 1000;

function invalidateSubscriberCache() {
  SUBS_CACHE.key = null;
  SUBS_CACHE.at = 0;
  SUBS_CACHE.subs = null;
}

// Fetch every active subscriber on the account with their tag memberships
// included. This is what we use to build an audience because Kit's per-tag
// endpoint truncates at ~2000 records, but /v4/subscribers paginates fully.
async function fetchAllSubscribersWithTags(apiKey, { force = false } = {}) {
  if (!force && SUBS_CACHE.key === apiKey && SUBS_CACHE.subs && (Date.now() - SUBS_CACHE.at) < SUBS_CACHE_TTL_MS) {
    return SUBS_CACHE.subs;
  }
  const out = [];
  let cursor;
  while (true) {
    const query = { per_page: 1000, include: 'tags' };
    if (cursor) query.after = cursor;
    const data = await kitFetch('GET', `/subscribers`, apiKey, { query });
    for (const s of (data.subscribers || [])) {
      out.push({
        id: s.id,
        email: s.email_address,
        tagIds: (s.tags || []).map(t => t.id),
      });
    }
    cursor = data.pagination?.has_next_page ? data.pagination.end_cursor : null;
    if (!cursor) break;
    if (out.length > 500_000) throw new Error('Pagination runaway (>500k subscribers)');
  }
  SUBS_CACHE.key = apiKey;
  SUBS_CACHE.at = Date.now();
  SUBS_CACHE.subs = out;
  return out;
}

// Build a campaign audience from include + exclude tag lists.
//   include: array of tag IDs — anyone in ANY of these tags qualifies (union)
//   exclude: array of tag IDs — anyone in any of these is removed
// Returns deduped [{id, email}] in deterministic order (sorted by id) so
// batch slicing is stable across reruns.
async function fetchAudienceByTagSelection(apiKey, { includeTagIds = [], excludeTagIds = [] } = {}) {
  if (!includeTagIds.length) {
    const err = new Error('No include tags selected. Pick at least one tag to include.');
    err.userFacing = true;
    throw err;
  }
  const includeSet = new Set(includeTagIds.map(Number));
  const excludeSet = new Set(excludeTagIds.map(Number));
  const all = await fetchAllSubscribersWithTags(apiKey);
  const out = [];
  for (const s of all) {
    const hasInclude = s.tagIds.some(id => includeSet.has(id));
    if (!hasInclude) continue;
    const hasExclude = s.tagIds.some(id => excludeSet.has(id));
    if (hasExclude) continue;
    out.push({ id: s.id, email: s.email });
  }
  return out.sort((a, b) => a.id - b.id);
}

// Tag subscribers serially with a fixed gap to stay under Kit's per-minute
// rate limit. Kit's /v4/bulk/* endpoints all require OAuth (we use API key),
// so we POST /v4/tags/{tag_id}/subscribers/{id} per subscriber. Even with
// retries on 429, the only reliable approach is to not trip the limit at
// all — hence 600ms gap → ~100 req/min, safely under Kit's window.
const TAG_GAP_MS = 600;

// Background tag/untag uses a larger backoff budget because they're not
// constrained by Cloudflare's 100s edge timeout (they run server-internal,
// invoked by the loop runner via setTimeout — no inbound HTTP request).
const BACKGROUND_BACKOFF_BUDGET_MS = 5 * 60 * 1000;

async function bulkTagSubscribers(apiKey, tagId, subscribers) {
  for (const sub of subscribers) {
    try {
      await kitFetch('POST', `/tags/${tagId}/subscribers/${sub.id}`, apiKey, {
        maxBackoffBudgetMs: BACKGROUND_BACKOFF_BUDGET_MS,
      });
    } catch (e) {
      throw new Error(`Failed to tag subscriber ${sub.id} (${sub.email}): ${e.message}`);
    }
    await sleep(TAG_GAP_MS);
  }
}

async function bulkUntagSubscribers(apiKey, tagId, subscribers) {
  for (const sub of subscribers) {
    try {
      await kitFetch('DELETE', `/tags/${tagId}/subscribers/${sub.id}`, apiKey, {
        maxBackoffBudgetMs: BACKGROUND_BACKOFF_BUDGET_MS,
      });
    } catch (_e) { /* best-effort untag */ }
    await sleep(TAG_GAP_MS);
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
  // Force to string so better-sqlite3 stores it cleanly in TEXT columns.
  // Otherwise JS Number → SQLite REAL → text "24110400.0" with the float suffix.
  return String(id);
}

// Test send — creates a DRAFT broadcast in Kit (no send_at, no published_at).
// The draft appears in Kit's Drafts tab where the user can manually trigger
// the in-Kit "send test to address" flow. Drafts can also be deleted via API
// (sent broadcasts can't), so the cleanup button actually works for these.
async function createTestBroadcast(apiKey, { subject, contentHtml, previewText, testTagId, fromEmail }) {
  const body = {
    subject: `[TEST] ${subject}`,
    content: withMaxWidth(contentHtml, 700),
    description: `[TEST] ${subject}`,
    public: false,
    subscriber_filter: [{ all: [{ type: 'tag', ids: [testTagId] }] }],
  };
  if (previewText) body.preview_text = previewText;
  if (fromEmail) body.email_address = fromEmail;
  const data = await kitFetch('POST', '/broadcasts', apiKey, { body });
  const id = data.broadcast?.id ?? data.id;
  if (!id) throw new Error('Kit draft broadcast created but no id returned');
  return id;
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
  fetchAudienceByTagSelection,
  fetchAllSubscribersWithTags,
  fetchSubscribersInTag,
  invalidateSubscriberCache,
  bulkTagSubscribers,
  bulkUntagSubscribers,
  createAndSendBroadcast,
  createTestBroadcast,
  listBroadcasts,
  deleteBroadcast,
  getBroadcastStats,
};
