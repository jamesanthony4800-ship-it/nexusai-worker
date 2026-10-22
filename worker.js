/**
 * NexusAI external worker — Phase 5
 *
 * An always-on service (Railway / Fly.io / any VPS) that polls the NexusAI
 * job queue on Base44, runs short jobs, and posts results back.
 *
 * Zero npm dependencies: Node.js 18+ (built-in fetch).
 *
 * Required env:
 *   NEXUSAI_BASE_URL   e.g. https://your-nexusai-app.base44.app
 *   WORKER_API_KEY      same value as the WORKER_API_KEY secret in the NexusAI app
 *   XAI_API_KEY         (x.ai / Grok)   — or —
 *   ANTHROPIC_API_KEY   (Anthropic / Claude)
 *
 * Optional env:
 *   POLL_INTERVAL_MS    default 15000
 *   MAX_CONCURRENT      default 2
 *   XAI_MODEL           default grok-3
 *   ANTHROPIC_MODEL     default claude-sonnet-4-20250514
 */

const BASE_URL = process.env.NEXUSAI_BASE_URL;
const WORKER_KEY = process.env.WORKER_API_KEY;
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS || "15000", 10);
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "2", 10);
const WORKER_ID = `worker-${Math.random().toString(36).slice(2, 8)}`;

if (!BASE_URL) {
  console.error("[fatal] NEXUSAI_BASE_URL is not set");
  process.exit(1);
}
if (!WORKER_KEY) {
  console.error("[fatal] WORKER_API_KEY is not set");
  process.exit(1);
}
if (!process.env.XAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  console.error("[fatal] set XAI_API_KEY or ANTHROPIC_API_KEY");
  process.exit(1);
}

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- Base44 API helpers ---------------- */

async function callEndpoint(name, body) {
  const res = await fetch(`${BASE_URL}/functions/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Worker-Key": WORKER_KEY },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`${name} -> HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

const claimJobs = () => callEndpoint("claimJobs", { worker_id: WORKER_ID, max: MAX_CONCURRENT });
const completeJob = (jobId, result) => callEndpoint("completeJob", { job_id: jobId, result, worker_id: WORKER_ID });
const failJob = (jobId, error) => callEndpoint("failJob", { job_id: jobId, error: String(error).slice(0, 2000), worker_id: WORKER_ID });

/* ---------------- LLM helpers ---------------- */

async function llm(systemPrompt, userPrompt) {
  if (process.env.XAI_API_KEY) {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.XAI_MODEL || "grok-3",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`xAI HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "(empty response)";
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.content?.map((c) => c.text).join("\n") || "(empty response)";
}

/* ---------------- Job executors ---------------- */

function parsePayload(job) {
  if (typeof job.payload === "string" && job.payload.trim().startsWith("{")) {
    try {
      return JSON.parse(job.payload);
    } catch {
      return { prompt: job.payload };
    }
  }
  if (typeof job.payload === "object" && job.payload) return job.payload;
  return { prompt: String(job.payload || "") };
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

const SYSTEM = "You are a worker agent inside the NexusAI platform. Follow the user's bot instructions carefully. Be concise and useful. You produce results for the app owner to review; you never send, pay, post, or delete anything yourself.";

const EXECUTORS = {
  async draft_reply(job) {
    const p = parsePayload(job);
    return llm(SYSTEM, `Draft a reply using the bot's instructions.\n\nContext:\n${p.context || ""}\n\nInstructions:\n${p.instructions || p.prompt || ""}`);
  },

  async research(job) {
    const p = parsePayload(job);
    return llm(SYSTEM, `Research this topic and produce a structured summary with key findings, open questions, and recommended next steps:\n\n${p.query || p.prompt}`);
  },

  async browse_page(job) {
    const p = parsePayload(job);
    const url = p.url || p.prompt;
    if (!/^https?:\/\//.test(String(url))) throw new Error(`Invalid URL: ${url}`);
    log(`  fetching ${url}`);
    const res = await fetch(url, { headers: { "User-Agent": "NexusAI-Worker/1.0" }, redirect: "follow" });
    if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`);
    const text = htmlToText(await res.text()).slice(0, 12000);
    const summary = await llm(SYSTEM, `Summarize this page content. Include the main points and anything actionable:\n\nURL: ${url}\n\nCONTENT:\n${text}`);
    return `URL: ${url}\n\n${summary}`;
  },

  async summarize(job) {
    const p = parsePayload(job);
    return llm(SYSTEM, `Summarize the following:\n\n${p.text || p.prompt}`);
  },
};

async function executeJob(job) {
  const type = (job.type || "generic").toLowerCase().trim();
  const executor = EXECUTORS[type];
  if (!executor) {
    if (type === "check_dms") {
      throw new Error("check_dms is not wired yet — no DM connector configured on this worker (Phase 6/8 work).");
    }
    // generic fallback: treat payload as a prompt
    const p = parsePayload(job);
    return llm(SYSTEM, p.prompt || JSON.stringify(p));
  }
  return executor(job);
}

/* ---------------- Main loop ---------------- */

let consecutiveErrors = 0;

async function pollOnce() {
  const claimed = await claimJobs();
  const jobs = Array.isArray(claimed?.jobs) ? claimed.jobs : [];
  if (jobs.length === 0) return;

  log(`claimed ${jobs.length} job(s)`);
  await Promise.all(
    jobs.map(async (job) => {
      const jobId = job.id || job._id;
      try {
        log(`  running job ${jobId} (${job.type})`);
        const result = await executeJob(job);
        await completeJob(jobId, result);
        log(`  done job ${jobId}`);
      } catch (err) {
        log(`  FAILED job ${jobId}: ${err.message}`);
        try {
          await failJob(jobId, err.message);
        } catch (e2) {
          log(`  could not report failure for ${jobId}: ${e2.message}`);
        }
      }
    })
  );
}

const ONCE = process.argv.includes("--once");

async function main() {
  if (ONCE) {
    // One-shot mode for GitHub Actions / cron hosting: claim what is queued, process it, exit.
    log(`one-shot mode — claiming up to ${MAX_CONCURRENT} job(s), then exiting`);
    try {
      await pollOnce();
      log("one-shot run complete");
      process.exit(0);
    } catch (err) {
      console.error(`[fatal] one-shot run failed: ${err.message}`);
      process.exit(1);
    }
  }
  log(`NexusAI worker ${WORKER_ID} starting — polling ${BASE_URL} every ${POLL_MS}ms`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await pollOnce();
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      const wait = Math.min(POLL_MS * Math.pow(2, Math.min(consecutiveErrors, 5)), 5 * 60 * 1000);
      log(`poll error (x${consecutiveErrors}): ${err.message} — retrying in ${Math.round(wait / 1000)}s`);
      if (consecutiveErrors >= 50) {
        log("too many consecutive errors, exiting (restart policy will revive me)");
        process.exit(1);
      }
      await sleep(wait);
      continue;
    }
    await sleep(POLL_MS);
  }
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
