# Kit Email AB Tester

Web UI for running a Karpathy-style A/B loop on Kit (ConvertKit) email subject
lines: send the same email body to your list in batches, pit the current winner
against an AI-generated challenger each round, keep the better performer, and
march through the list until everyone has been hit with an optimized subject.

Built for non-technical staff: admin pre-loads the API keys, staff just fill in
the form, preview, test, and click Launch.

## Quick start

```bash
cd kit-email-ab-tester
cp .env.example .env       # optional — defaults work for local use
npm install
npm start
```

Open <http://localhost:3000/>. On first load, the Setup panel pops up — paste your Kit secret API key and your OpenAI key, hit Save, and you're ready.

## Pages

- **`/`** — everything. Setup panel (collapsed once keys are saved), new-campaign form with rich text editor, audience picker (tags or segments), preview, test send, launch. Plus a list of past campaigns at the bottom.
- **`/campaigns/:id`** — live monitor for a running campaign with round-by-round open rates and pause/resume.

There's no login. The URL itself is the gate — keep it on localhost, a Tailscale tunnel, or behind a firewall. Anyone who reaches the URL can edit the saved API keys, so if you ever expose it to the open internet, put a reverse-proxy auth layer in front (Caddy basic auth, Cloudflare Access, etc.).

API keys are persisted to SQLite on the server so background campaigns can run for hours without the browser staying open. They're never echoed back to the browser in full — you'll only see the last 4 characters after saving.

## How a round works

Per round (default: 1,000 people, 60 minute wait):

1. Fetch the audience from Kit (paginated, all subscribers in the tag/segment).
2. Split the next 1,000 into two halves of 500.
3. Ask OpenAI for a challenger subject line that might beat the current winner.
4. **Tag** half A with a fresh temp tag, half B with a different fresh temp tag (so Kit broadcasts can target each half).
5. Create two Kit broadcasts — one with the current-winner subject, one with the challenger subject — both with the same email body.
6. Wait the configured number of minutes for opens to land.
7. Pull each broadcast's open rate from Kit. Higher rate wins.
8. The winner becomes the new baseline; advance to the next batch of 1,000.

State is persisted to SQLite, so a server restart resumes any campaigns mid-flight.

## What's in the box

```
src/
  server.js          Express routes
  db.js              SQLite schema (campaigns, rounds, settings)
  kit-client.js      Kit v3 API wrapper
  openai-client.js   OpenAI subject-line generator
  loop-runner.js     Campaign state machine (send → wait → evaluate → advance)

public/
  index.html         Setup panel + new-campaign form + past campaigns list
  monitor.html       Live campaign status (auto-refreshes every 5s)
  css/style.css
  js/staff.js
```

## Important Kit API caveat

This app hits the **ConvertKit v3 API**: `https://api.convertkit.com/v3/...`.

**The send-vs-draft question:** Kit's v3 `POST /v3/broadcasts` creates a *broadcast object*. Whether that broadcast actually **sends** without a manual publish step depends on your Kit account / plan. If you find that broadcasts pile up as drafts in your Kit UI rather than sending, you have two options:

1. Run the loop a step at a time and publish each pair manually in the Kit UI (annoying).
2. Upgrade to the v4 Kit API and switch the client to use the bearer-token endpoint that supports immediate scheduled sends. This would mean editing `src/kit-client.js` to use `https://api.kit.com/v4/broadcasts` and adding the `subscriber_filter` payload — Kit's v4 docs at developers.kit.com cover this.

The test-send endpoint has the same caveat. The UI tells the user that drafts may need a manual publish.

## Sending to specific subscribers

Kit broadcasts target **tags/segments**, not arbitrary subscriber-ID lists. To send each A/B half-batch independently, this app creates a temp tag per half, tags the right subscribers into it, then broadcasts to that tag. Tags are left in place after the round (cheap, no harm) — admin can bulk-delete tags starting with `abtest-` periodically.

## Deploy notes

Anywhere that runs Node 18+ works (Render, Railway, Fly.io, a VPS). Mount a persistent volume at `data/` so the SQLite file survives restarts. Set `PORT` to whatever the host wants.

## What this is not

- Not a transactional email tool. The list and the sending all go through your Kit account.
- Not a deliverability fix. If your Kit deliverability is bad, this won't help; it just optimizes which words land in people's inboxes.
- Not a way to A/B test bodies. Subject line only — that's the deliberate scope.
