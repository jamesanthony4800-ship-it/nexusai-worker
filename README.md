# NexusAI Worker (Phase 5)

The always-on half of NexusAI. It polls the job queue on Base44 every few
seconds, claims queued jobs, runs them, and posts results back. Base44 stays
the dashboard; this worker is the hands.

No npm dependencies. Node.js 18+.

## What it can do (v1)

| Job type | What happens |
|---|---|
| `draft_reply` | LLM drafts a reply from the bot's instructions + context |
| `research` | LLM researches a topic and returns a structured summary |
| `browse_page` | Fetches a URL, extracts text, LLM summarizes the page |
| `summarize` | LLM summarizes provided text |
| anything else | Treated as a generic LLM prompt |
| `check_dms` | Not wired yet (needs a DM connector — later phase) |

Nothing here sends emails, posts, pays, or deletes. Results flow back to
Base44, where anything actionable still needs your approval (ask-first).

## Environment variables

| Var | Required | Example |
|---|---|---|
| `NEXUSAI_BASE_URL` | yes | `https://your-nexusai-app.base44.app` |
| `WORKER_API_KEY` | yes | same value you set as `WORKER_API_KEY` in NexusAI Secrets |
| `XAI_API_KEY` | one of these | x.ai console key (Grok) |
| `ANTHROPIC_API_KEY` | one of these | console.anthropic.com key (Claude) |
| `POLL_INTERVAL_MS` | no | `15000` (default) |
| `MAX_CONCURRENT` | no | `2` (default) |
| `XAI_MODEL` | no | `grok-3` (default) |
| `ANTHROPIC_MODEL` | no | `claude-sonnet-4-20250514` (default) |

## Setup checklist (one-time)

1. In the NexusAI app editor → **Secrets**, add `WORKER_API_KEY` with any
   strong random value (e.g. `openssl rand -hex 32`). The queue functions
   refuse to work without it.
2. Note your NexusAI base URL (the app's published `*.base44.app` URL).
3. Deploy this worker anywhere that runs Docker/Node permanently and set the
   env vars above. The `WORKER_API_KEY` must match the app secret exactly.
4. Queue a test job in NexusAI (Jobs page → New job, type `research`, payload
   `{"query": "test"}`) and watch it go queued → claimed → done.

## Deploy: Railway (easiest)

1. Sign up at railway.app, create a new project → Deploy from repo
   (push this folder to GitHub), or use `railway init` + `railway up` from CLI.
2. In the service → Variables, add the env vars above.
3. Railway auto-restarts the worker if it crashes. Done.

## Deploy: Fly.io

```bash
fly launch --no-deploy          # in this folder; accept defaults
fly secrets set \
  NEXUSAI_BASE_URL=... \
  WORKER_API_KEY=... \
  XAI_API_KEY=...
fly deploy
```

## Deploy: any VPS

```bash
# Node 18+ required
npm install -g pm2
WORKER_API_KEY=... NEXUSAI_BASE_URL=... XAI_API_KEY=... \
  pm2 start worker.js --name nexusai-worker
pm2 save && pm2 startup        # survive reboots
```

## How it talks to Base44

- `POST {NEXUSAI_BASE_URL}/functions/claimJobs` with header `X-Worker-Key` — claims up to `MAX_CONCURRENT` queued jobs
- `POST {NEXUSAI_BASE_URL}/functions/completeJob` — posts a result, job marked done
- `POST {NEXUSAI_BASE_URL}/functions/failJob` — posts an error, job marked failed (retry from the Jobs page)

If the key is missing or wrong, claimJobs returns 401 and the worker backs
off exponentially instead of hammering the API.

## Phase 6 preview

This worker is the place where the real browser loop (screenshot → decide →
click) will live later. Keep it deployed and upgrading is just a redeploy.
