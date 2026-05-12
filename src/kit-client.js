// Kit (ConvertKit) v3 API client.
//
// Notes on send strategy:
//   ConvertKit v3 broadcasts are normally targeted at tags/segments, not
//   ad-hoc subscriber-ID lists. So for each A/B half-batch we:
//     1. Create a short-lived "test tag" in Kit.
//     2. Tag the chosen subscribers with it.
//     3. Create a broadcast and publish it to that tag.
//     4. After the wait+evaluate cycle, untag the subscribers and remove the tag.
//
//   The legacy v3 endpoints we use:
//     GET    /v3/tags?api_secret=...
//     POST   /v3/tags
//     POST   /v3/tags/{id}/subscribe
//     DELETE /v3/subscribers/{id}/tags/{tag_id}
//     GET    /v3/tags/{id}/subscriptions
//     GET    /v3/segments/{id}/subscribers   (some accounts; segments may need v4)
//     POST   /v3/broadcasts
//     GET    /v3/broadcasts/{id}/stats
//
//   Kit's v3 endpoints take api_secret as a query param. Some accounts
//   require the v4 API + bearer token instead — see README for the
//   migration knobs if v3 calls return 401.

const KIT_BASE = 'https://api.convertkit.com/v3';

function requireKey(apiSecret) {
  if (!apiSecret) {
    const err = new Error('Kit API secret not configured. An admin needs to set it in /admin.');
    err.userFacing = true;
    throw err;
  }
}

async function kitGet(path, apiSecret, query = {}) {
  requireKey(apiSecret);
  const params = new URLSearchParams({ api_secret: apiSecret, ...query });
  const res = await fetch(`${KIT_BASE}${path}?${params}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Kit GET ${path} failed: ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function kitPost(path, apiSecret, body) {
  requireKey(apiSecret);
  const res = await fetch(`${KIT_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_secret: apiSecret, ...body }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kit POST ${path} failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function kitDelete(path, apiSecret, body) {
  requireKey(apiSecret);
  const res = await fetch(`${KIT_BASE}${path}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_secret: apiSecret, ...body }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kit DELETE ${path} failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function listTags(apiSecret) {
  const data = await kitGet('/tags', apiSecret);
  return (data.tags || []).map(t => ({ id: String(t.id), name: t.name }));
}

async function listSegments(apiSecret) {
  // Older accounts may not expose segments on v3; return empty rather than throwing
  // so the UI can fall back to tags-only.
  try {
    const data = await kitGet('/segments', apiSecret);
    return (data.segments || []).map(s => ({ id: String(s.id), name: s.name }));
  } catch (_e) {
    return [];
  }
}

async function createTag(apiSecret, name) {
  const data = await kitPost('/tags', apiSecret, { tag: { name } });
  // Different Kit responses use either {tag: {id}} or [{id}]; normalize
  const tag = Array.isArray(data) ? data[0] : data.tag || data;
  return String(tag.id);
}

async function tagSubscriber(apiSecret, tagId, email) {
  return kitPost(`/tags/${tagId}/subscribe`, apiSecret, { email });
}

async function untagSubscriber(apiSecret, subscriberId, tagId) {
  return kitDelete(`/subscribers/${subscriberId}/tags/${tagId}`, apiSecret);
}

async function fetchAllSubscribersForAudience(apiSecret, audienceType, audienceId) {
  const out = [];
  let page = 1;
  while (true) {
    const path = audienceType === 'segment'
      ? `/segments/${audienceId}/subscribers`
      : `/tags/${audienceId}/subscriptions`;
    const data = await kitGet(path, apiSecret, { page, sort_order: 'asc' });
    let batch;
    if (audienceType === 'segment') {
      batch = (data.subscribers || []).map(s => ({ id: s.id, email: s.email_address }));
    } else {
      batch = (data.subscriptions || [])
        .filter(s => s.subscriber)
        .map(s => ({ id: s.subscriber.id, email: s.subscriber.email_address }));
    }
    out.push(...batch);
    if (batch.length < 50) break;
    page += 1;
    if (page > 5000) throw new Error('Pagination runaway (>5000 pages)');
  }
  return out;
}

async function createBroadcast(apiSecret, { subject, contentHtml }) {
  const data = await kitPost('/broadcasts', apiSecret, {
    subject,
    content: contentHtml,
    public: false,
  });
  const id = data.broadcast?.id ?? data.id;
  if (!id) throw new Error('Kit broadcast created but no id returned');
  return String(id);
}

async function getBroadcastStats(apiSecret, broadcastId) {
  const data = await kitGet(`/broadcasts/${broadcastId}/stats`, apiSecret);
  const stats = data.broadcast?.stats || data.stats || {};
  const opens = stats.open_count ?? stats.opens ?? 0;
  const recipients = stats.recipient_count ?? stats.recipients ?? 0;
  return { opens, recipients, openRate: recipients ? (opens / recipients) * 100 : 0 };
}

// Tag a batch of subscribers in parallel (capped concurrency so we don't hammer the API).
async function tagSubscribersBatch(apiSecret, tagId, subscribers, concurrency = 5) {
  let i = 0;
  async function worker() {
    while (i < subscribers.length) {
      const idx = i++;
      const sub = subscribers[idx];
      await tagSubscriber(apiSecret, tagId, sub.email);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

async function untagSubscribersBatch(apiSecret, tagId, subscribers, concurrency = 5) {
  let i = 0;
  async function worker() {
    while (i < subscribers.length) {
      const idx = i++;
      const sub = subscribers[idx];
      try { await untagSubscriber(apiSecret, sub.id, tagId); } catch (_e) { /* best-effort */ }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

module.exports = {
  listTags,
  listSegments,
  createTag,
  tagSubscriber,
  untagSubscriber,
  tagSubscribersBatch,
  untagSubscribersBatch,
  fetchAllSubscribersForAudience,
  createBroadcast,
  getBroadcastStats,
};
