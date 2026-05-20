// Campaign loop runner.
//
// State machine — each campaign moves through these states:
//   draft   → not started yet
//   running → either between rounds or waiting for opens
//   paused  → user paused; can resume
//   done    → all rounds complete
//   error   → terminated with last_error set
//
// The runner persists `next_action` and `next_run_at` to SQLite so a server
// restart resumes pending work. On boot the server calls `resumeAll()`.
//
// Actions:
//   'send'     → fetch subscribers, split next batch, tag both halves,
//                create both broadcasts, then schedule 'evaluate' after wait_seconds.
//   'evaluate' → pull stats for both broadcasts, pick winner, untag, advance.

const { db, getSetting } = require('./db');
const kit = require('./kit-client');

const tickTimers = new Map(); // campaignId → setTimeout handle

function now() { return Date.now(); }

function getCampaign(id) {
  return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
}

function getActiveRound(campaignId, roundNumber) {
  return db.prepare(
    'SELECT * FROM rounds WHERE campaign_id = ? AND round_number = ?'
  ).get(campaignId, roundNumber);
}

function getRoundMatches(campaignId, roundNumber) {
  return db.prepare(
    'SELECT * FROM rounds WHERE campaign_id = ? AND round_number = ? ORDER BY match_number ASC'
  ).all(campaignId, roundNumber);
}

function getMatchWinnerSubject(m) {
  return m.outcome === 'challenger_won' ? m.challenger_subject : m.winner_subject;
}

function updateCampaign(id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sets = keys.map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE campaigns SET ${sets}, updated_at = @updated_at WHERE id = @id`).run({
    ...patch, id, updated_at: now(),
  });
}

function insertRound(row) {
  const stmt = db.prepare(`
    INSERT INTO rounds (campaign_id, round_number, match_number, winner_subject, challenger_subject)
    VALUES (@campaign_id, @round_number, @match_number, @winner_subject, @challenger_subject)
  `);
  return stmt.run({ match_number: 1, ...row }).lastInsertRowid;
}

function updateRound(id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sets = keys.map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE rounds SET ${sets} WHERE id = @id`).run({ ...patch, id });
}

function logError(campaignId, err) {
  console.error(`[campaign ${campaignId}]`, err);
  updateCampaign(campaignId, {
    status: 'error',
    last_error: (err && err.message) ? err.message : String(err),
  });
}

async function performSend(campaignId) {
  const campaign = getCampaign(campaignId);
  if (!campaign || campaign.status !== 'running') return;

  const kitKey = getSetting('kit_api_key');
  const lineup = JSON.parse(campaign.subject_lineup || '[]');

  // Pull the audience to size the campaign — union of include tags, minus any
  // subscribers in the exclude tags.
  const includeTagIds = JSON.parse(campaign.audience_include_tags || '[]');
  const excludeTagIds = JSON.parse(campaign.audience_exclude_tags || '[]');
  const subscribers = await kit.fetchAudienceByTagSelection(kitKey, {
    includeTagIds,
    excludeTagIds,
  });
  const audienceRounds = Math.ceil(subscribers.length / campaign.batch_size);

  // We only do A/B for as many rounds as we have challengers in the lineup
  // (lineup[0] is the starting subject; the rest are challengers).
  const abRounds = Math.max(0, lineup.length - 1);
  const totalRounds = Math.min(audienceRounds, abRounds);
  updateCampaign(campaignId, { total_rounds: totalRounds });

  const roundNumber = campaign.current_round + 1;
  if (roundNumber > totalRounds) {
    // Out of challengers OR out of audience — done. Remaining audience (if any)
    // can be sent the final winner via a separate "blast remainder" action,
    // but for simplicity we leave that as a manual step the user can take in Kit.
    updateCampaign(campaignId, { status: 'done', next_action: null, next_run_at: null });
    return;
  }

  const start = (roundNumber - 1) * campaign.batch_size;
  const batch = subscribers.slice(start, start + campaign.batch_size);
  const half = Math.ceil(batch.length / 2);
  const groupA = batch.slice(0, half);            // current winner
  const groupB = batch.slice(half);               // next challenger from lineup

  // Challenger is the next entry in the lineup after the starting subject.
  // Round 1 → lineup[1], Round 2 → lineup[2], etc.
  const challenger = lineup[roundNumber];
  if (!challenger) {
    updateCampaign(campaignId, { status: 'done', next_action: null, next_run_at: null });
    return;
  }

  // Create the round record now so it shows up on the monitor immediately.
  const roundId = insertRound({
    campaign_id: campaignId,
    round_number: roundNumber,
    winner_subject: campaign.current_winner,
    challenger_subject: challenger,
  });

  // Temp tags so subscriber_filter can target each half-batch.
  const stamp = Date.now();
  const winnerTagId = await kit.createTag(kitKey, `abtest-c${campaignId}-r${roundNumber}-A-${stamp}`);
  const challengerTagId = await kit.createTag(kitKey, `abtest-c${campaignId}-r${roundNumber}-B-${stamp}`);

  await kit.bulkTagSubscribers(kitKey, winnerTagId, groupA);
  await kit.bulkTagSubscribers(kitKey, challengerTagId, groupB);

  // v4: created broadcast sends immediately because send_at is "now".
  const winnerBroadcastId = await kit.createAndSendBroadcast(kitKey, {
    subject: campaign.current_winner,
    contentHtml: campaign.email_html,
    previewText: campaign.preview_text || '',
    targetTagId: winnerTagId,
  });
  const challengerBroadcastId = await kit.createAndSendBroadcast(kitKey, {
    subject: challenger,
    contentHtml: campaign.email_html,
    previewText: campaign.preview_text || '',
    targetTagId: challengerTagId,
  });

  const evaluateAt = now() + campaign.wait_seconds * 1000;
  updateRound(roundId, {
    winner_broadcast_id: winnerBroadcastId,
    challenger_broadcast_id: challengerBroadcastId,
    winner_tag_id: winnerTagId,
    challenger_tag_id: challengerTagId,
    winner_recipients: groupA.length,
    challenger_recipients: groupB.length,
    sent_at: now(),
    scheduled_evaluate_at: evaluateAt,
    status: 'waiting',
  });

  updateCampaign(campaignId, {
    current_round: roundNumber,
    next_action: 'evaluate',
    next_run_at: evaluateAt,
  });
  scheduleTick(campaignId, evaluateAt);
}

async function performEvaluate(campaignId) {
  const campaign = getCampaign(campaignId);
  if (!campaign || campaign.status !== 'running') return;

  const kitKey = getSetting('kit_api_key');
  const round = getActiveRound(campaignId, campaign.current_round);
  if (!round) return;

  const winnerStats = await kit.getBroadcastStats(kitKey, round.winner_broadcast_id);
  const challengerStats = await kit.getBroadcastStats(kitKey, round.challenger_broadcast_id);

  const outcome = challengerStats.openRate > winnerStats.openRate
    ? 'challenger_won' : 'winner_kept';

  updateRound(round.id, {
    winner_opens: winnerStats.opens,
    challenger_opens: challengerStats.opens,
    winner_rate: winnerStats.openRate,
    challenger_rate: challengerStats.openRate,
    outcome,
    evaluated_at: now(),
    status: 'done',
  });

  // Clean up temp tags (best-effort).
  // We don't have the subscriber list cached here; in practice Kit lets you
  // delete a tag entirely, which removes it from all subscribers. If the API
  // supports DELETE /v3/tags/{id} we could call that. For now we leave the
  // tags in place — they cost nothing in Kit, just clutter, and admin can
  // bulk-delete by name prefix `abtest-`.

  const nextWinner = outcome === 'challenger_won'
    ? round.challenger_subject : round.winner_subject;

  const isDone = campaign.current_round >= (campaign.total_rounds || campaign.current_round);
  updateCampaign(campaignId, {
    current_winner: nextWinner,
    next_action: isDone ? null : 'send',
    next_run_at: isDone ? null : now(),
    status: isDone ? 'done' : 'running',
  });
  if (!isDone) scheduleTick(campaignId, now());
}

// ─── Tournament mode (5-subject bracket) ──────────────────────────────────
//
// Bracket for 5 subjects [S1..S5]:
//   Round 1: M1 (S1 vs S2)  and  M2 (S3 vs S4) — sent back-to-back, parallel
//   Round 2: M1 (W_R1M1 vs W_R1M2) — semifinal
//   Round 3: M1 (W_R2M1 vs S5)     — final
//
// Audience usage: 4 batches × batch_size (R1 uses 2 batches, R2 + R3 use 1 each).

async function performSendTournament(campaignId) {
  const campaign = getCampaign(campaignId);
  if (!campaign || campaign.status !== 'running') return;

  const kitKey = getSetting('kit_api_key');
  const lineup = JSON.parse(campaign.subject_lineup || '[]');
  if (lineup.length !== 5) {
    throw new Error(`Tournament mode requires exactly 5 subjects (got ${lineup.length})`);
  }

  const includeTagIds = JSON.parse(campaign.audience_include_tags || '[]');
  const excludeTagIds = JSON.parse(campaign.audience_exclude_tags || '[]');
  const subscribers = await kit.fetchAudienceByTagSelection(kitKey, {
    includeTagIds, excludeTagIds,
  });

  const TOTAL_ROUNDS = 3;
  updateCampaign(campaignId, { total_rounds: TOTAL_ROUNDS });

  const roundNumber = campaign.current_round + 1;
  if (roundNumber > TOTAL_ROUNDS) {
    updateCampaign(campaignId, { status: 'done', next_action: null, next_run_at: null });
    return;
  }

  // Determine matches for this round and which slice of the audience each uses.
  // sliceIndex maps to which contiguous batch slot in the audience that match
  // consumes (so total of 4 slots: R1M1=0, R1M2=1, R2M1=2, R3M1=3).
  const matchPlans = [];
  if (roundNumber === 1) {
    matchPlans.push({ matchNumber: 1, sliceIndex: 0, subjectA: lineup[0], subjectB: lineup[1] });
    matchPlans.push({ matchNumber: 2, sliceIndex: 1, subjectA: lineup[2], subjectB: lineup[3] });
  } else if (roundNumber === 2) {
    const r1 = getRoundMatches(campaignId, 1);
    if (r1.length !== 2) throw new Error('Tournament: round 1 must have 2 matches before round 2');
    matchPlans.push({
      matchNumber: 1, sliceIndex: 2,
      subjectA: getMatchWinnerSubject(r1[0]),
      subjectB: getMatchWinnerSubject(r1[1]),
    });
  } else if (roundNumber === 3) {
    const r2 = getRoundMatches(campaignId, 2);
    if (r2.length !== 1) throw new Error('Tournament: round 2 must have 1 match before round 3');
    matchPlans.push({
      matchNumber: 1, sliceIndex: 3,
      subjectA: getMatchWinnerSubject(r2[0]),
      subjectB: lineup[4],
    });
  }

  // Send each planned match: insert round record, tag both halves, create broadcasts.
  // Matches within a round are sent back-to-back (rate limits prevent parallel
  // tagging anyway), so all matches in this round end up with the same
  // scheduled_evaluate_at.
  const evaluateAt = now() + campaign.wait_seconds * 1000;
  for (const plan of matchPlans) {
    const sliceStart = plan.sliceIndex * campaign.batch_size;
    const matchBatch = subscribers.slice(sliceStart, sliceStart + campaign.batch_size);
    const halfSize = Math.ceil(matchBatch.length / 2);
    const groupA = matchBatch.slice(0, halfSize);
    const groupB = matchBatch.slice(halfSize);

    const roundId = insertRound({
      campaign_id: campaignId,
      round_number: roundNumber,
      match_number: plan.matchNumber,
      winner_subject: plan.subjectA,
      challenger_subject: plan.subjectB,
    });

    const stamp = Date.now();
    const tagA = await kit.createTag(kitKey, `abtest-c${campaignId}-r${roundNumber}-m${plan.matchNumber}-A-${stamp}`);
    const tagB = await kit.createTag(kitKey, `abtest-c${campaignId}-r${roundNumber}-m${plan.matchNumber}-B-${stamp}`);

    await kit.bulkTagSubscribers(kitKey, tagA, groupA);
    await kit.bulkTagSubscribers(kitKey, tagB, groupB);

    const bIdA = await kit.createAndSendBroadcast(kitKey, {
      subject: plan.subjectA,
      contentHtml: campaign.email_html,
      previewText: campaign.preview_text || '',
      targetTagId: tagA,
    });
    const bIdB = await kit.createAndSendBroadcast(kitKey, {
      subject: plan.subjectB,
      contentHtml: campaign.email_html,
      previewText: campaign.preview_text || '',
      targetTagId: tagB,
    });

    updateRound(roundId, {
      winner_broadcast_id: bIdA,
      challenger_broadcast_id: bIdB,
      winner_tag_id: tagA,
      challenger_tag_id: tagB,
      winner_recipients: groupA.length,
      challenger_recipients: groupB.length,
      sent_at: now(),
      scheduled_evaluate_at: evaluateAt,
      status: 'waiting',
    });
  }
  updateCampaign(campaignId, {
    current_round: roundNumber,
    next_action: 'evaluate',
    next_run_at: evaluateAt,
  });
  scheduleTick(campaignId, evaluateAt);
}

async function performEvaluateTournament(campaignId) {
  const campaign = getCampaign(campaignId);
  if (!campaign || campaign.status !== 'running') return;

  const kitKey = getSetting('kit_api_key');
  const matches = getRoundMatches(campaignId, campaign.current_round);
  if (!matches.length) return;

  for (const m of matches) {
    const aStats = await kit.getBroadcastStats(kitKey, m.winner_broadcast_id);
    const bStats = await kit.getBroadcastStats(kitKey, m.challenger_broadcast_id);
    const outcome = bStats.openRate > aStats.openRate ? 'challenger_won' : 'winner_kept';
    updateRound(m.id, {
      winner_opens: aStats.opens,
      challenger_opens: bStats.opens,
      winner_rate: aStats.openRate,
      challenger_rate: bStats.openRate,
      outcome,
      evaluated_at: now(),
    });
  }

  // current_winner = winner of the last match in this round (for R1, that's M2's winner;
  // for R2/R3, the only match's winner). For R3 it's the final tournament winner.
  const evaluated = getRoundMatches(campaignId, campaign.current_round);
  const lastWinner = getMatchWinnerSubject(evaluated[evaluated.length - 1]);

  const isDone = campaign.current_round >= 3;
  updateCampaign(campaignId, {
    current_winner: lastWinner,
    next_action: isDone ? null : 'send',
    next_run_at: isDone ? null : now(),
    status: isDone ? 'done' : 'running',
  });
  if (!isDone) scheduleTick(campaignId, now());
}

// ─── Tick dispatcher ──────────────────────────────────────────────────────

async function tick(campaignId) {
  tickTimers.delete(campaignId);
  const campaign = getCampaign(campaignId);
  if (!campaign || campaign.status !== 'running' || !campaign.next_action) return;
  const isTournament = campaign.campaign_type === 'tournament';
  try {
    if (campaign.next_action === 'send') {
      await (isTournament ? performSendTournament(campaignId) : performSend(campaignId));
    } else if (campaign.next_action === 'evaluate') {
      await (isTournament ? performEvaluateTournament(campaignId) : performEvaluate(campaignId));
    }
  } catch (err) {
    logError(campaignId, err);
  }
}

function scheduleTick(campaignId, runAtMs) {
  if (tickTimers.has(campaignId)) {
    clearTimeout(tickTimers.get(campaignId));
  }
  const delay = Math.max(0, runAtMs - now());
  const handle = setTimeout(() => tick(campaignId), delay);
  tickTimers.set(campaignId, handle);
}

function start(campaignId) {
  const campaign = getCampaign(campaignId);
  if (!campaign) throw new Error('Campaign not found');
  if (campaign.status === 'running') return;
  updateCampaign(campaignId, {
    status: 'running',
    next_action: 'send',
    next_run_at: now(),
    last_error: null,
  });
  scheduleTick(campaignId, now());
}

function pause(campaignId) {
  const campaign = getCampaign(campaignId);
  if (!campaign) return;
  if (tickTimers.has(campaignId)) clearTimeout(tickTimers.get(campaignId));
  tickTimers.delete(campaignId);
  updateCampaign(campaignId, { status: 'paused' });
}

function resume(campaignId) {
  const campaign = getCampaign(campaignId);
  if (!campaign) return;
  if (campaign.status !== 'paused') return;
  updateCampaign(campaignId, { status: 'running' });
  scheduleTick(campaignId, campaign.next_run_at || now());
}

// Retry an errored campaign. Removes any round records that didn't make it
// to "sent" state (no broadcast IDs attached), resets last_error, and
// restarts the loop from the current_round + 1.
function retry(campaignId) {
  const campaign = getCampaign(campaignId);
  if (!campaign) throw new Error('Campaign not found');
  if (campaign.status !== 'error') throw new Error(`Cannot retry — campaign is ${campaign.status}`);
  // Delete any half-baked round records (sent_at is null)
  db.prepare('DELETE FROM rounds WHERE campaign_id = ? AND sent_at IS NULL').run(campaignId);
  updateCampaign(campaignId, {
    status: 'running',
    next_action: 'send',
    next_run_at: now(),
    last_error: null,
  });
  scheduleTick(campaignId, now());
}

function resumeAll() {
  const rows = db.prepare(
    "SELECT id, next_run_at FROM campaigns WHERE status = 'running'"
  ).all();
  for (const row of rows) {
    scheduleTick(row.id, row.next_run_at || now());
  }
  return rows.length;
}

module.exports = { start, pause, resume, retry, resumeAll };
