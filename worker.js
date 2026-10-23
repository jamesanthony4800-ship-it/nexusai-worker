/**
 * NexusAI external worker — v6 (Railway-ready: health port, local state fallback)
 *
 * An always-on service (Railway / Fly.io / any VPS) that polls the NexusAI
 * job queue on Base44, runs short jobs, and posts results back.
 *
 * Zero npm dependencies for all job types except "browser" (and render:true),\n * which needs Playwright installed on the host (npm install playwright).
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

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const http = require("http");

const STATE_FILE = process.env.STATE_FILE || "/data/state/pages.json";

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


/* ---------------- Monitor state (stored in this repo) ---------------- */

const STATE_API = process.env.STATE_API_BASE || "https://api.github.com";

function stateRepo() {
  return process.env.GITHUB_REPOSITORY || null;
}

async function loadMonitorState() {
  const repo = stateRepo();
  if (!repo || !process.env.GITHUB_TOKEN) {
    try {
      return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
    } catch (e) {
      log(`  (monitor state file unreadable: ${e.message})`);
      return {};
    }
  }
  try {
    const res = await fetch(`${STATE_API}/repos/${repo}/contents/state/pages.json`, {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        "User-Agent": "NexusAI-Worker",
        Accept: "application/vnd.github.raw+json",
      },
    });
    if (res.status === 404) return {};
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return JSON.parse(await res.text());
  } catch (e) {
    log(`  (monitor state unavailable: ${e.message})`);
    return {};
  }
}

async function saveMonitorState(state) {
  const repo = stateRepo();
  if (!repo || !process.env.GITHUB_TOKEN) {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      return true;
    } catch (e) {
      log(`  (monitor state NOT saved to ${STATE_FILE}: ${e.message})`);
      return false;
    }
  }
  const api = `${STATE_API}/repos/${repo}/contents/state/pages.json`;
  try {
    let sha;
    const head = await fetch(api, { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, "User-Agent": "NexusAI-Worker" } });
    if (head.ok) sha = (await head.json()).sha;
    const body = JSON.stringify(state, null, 2);
    const put = await fetch(api, {
      method: "PUT",
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, "User-Agent": "NexusAI-Worker", "Content-Type": "application/json" },
      body: JSON.stringify({ message: "worker: update monitor state", content: Buffer.from(body).toString("base64"), sha }),
    });
    if (!put.ok) throw new Error(`HTTP ${put.status}: ${(await put.text()).slice(0, 200)}`);
    return true;
  } catch (e) {
    log(`  (monitor state NOT saved: ${e.message})`);
    return false;
  }
}

/* ---------------- Headless browser (Playwright, optional) ---------------- */

let _pw = null;
function playwright() {
  if (_pw === null) {
    try { _pw = require("playwright"); }
    catch { _pw = false; }
  }
  return _pw || null;
}

const PW_TIMEOUT_MS = parseInt(process.env.PW_TIMEOUT_MS || "45000", 10);

async function renderPageText(url) {
  const pw = playwright();
  if (!pw) throw new Error("playwright not installed on this host (run: npm install playwright && npx playwright install --with-deps chromium)");
  let browser;
  try {
    log(`  rendering ${url} in headless Chromium`);
    browser = await pw.chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const page = await (await browser.newContext({ userAgent: "NexusAI-Worker/1.0 (headless Chromium)" })).newPage();
    const resp = await page.goto(url, { waitUntil: "networkidle", timeout: PW_TIMEOUT_MS });
    if (resp && resp.status() >= 400) throw new Error(`render ${url} -> HTTP ${resp.status()}`);
    await page.waitForTimeout(1200); // let late content settle
    const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").trim();
    const title = await page.title();
    return { text, title, rendered: true };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function fetchPageText(url) {
  log(`  fetching ${url}`);
  const res = await fetch(url, { headers: { "User-Agent": "NexusAI-Worker/1.0" }, redirect: "follow" });
  if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`);
  return { text: htmlToText(await res.text()), title: null, rendered: false };
}

// Shared entry: plain fetch by default; Playwright render when p.render is true
// or the job type is "browser". Falls back to plain fetch if Playwright is
// unavailable AND the job allows it (render flag) — never for explicit "browser" jobs.
async function getPageText(url, opts = {}) {
  const wantRender = opts.render === true || opts.force === true;
  if (wantRender) {
    if (playwright()) return renderPageText(url);
    if (opts.force) throw new Error("playwright not installed on this host (needs a host with browser support)");
    log("  playwright not available, falling back to plain fetch");
  }
  return fetchPageText(url);
}

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
    const { text } = await getPageText(url, { render: p.render === true });
    const sliced = text.slice(0, 12000);
    const summary = await llm(SYSTEM, `Summarize this page content. Include the main points and anything actionable:\n\nURL: ${url}\n\nCONTENT:\n${sliced}`);
    return `URL: ${url}\n\n${summary}`;
  },

  async browser(job) {
    const p = parsePayload(job);
    const url = p.url || p.prompt;
    if (!/^https?:\/\//.test(String(url))) throw new Error(`Invalid URL: ${url}`);
    const { text, title } = await getPageText(url, { force: true });
    const sliced = text.slice(0, 12000);
    const summary = await llm(SYSTEM, `This page was rendered in a real browser (JavaScript executed). Summarize the content, which may include dynamic/app-like elements. Include the main points and anything actionable:\n\nURL: ${url}${title ? `\nTitle: ${title}` : ""}\n\nCONTENT:\n${sliced}`);
    return `URL: ${url} (rendered in headless browser)\n\n${summary}`;
  },

  async browse(job) {
    return EXECUTORS.browse_page(job);
  },

  async monitor(job) {
    const p = parsePayload(job);
    const url = p.url || p.prompt;
    if (!/^https?:\/\//.test(String(url))) throw new Error(`Invalid URL: ${url}`);
    const { text: rawText } = await getPageText(url, { render: p.render === true });
    const text = rawText.slice(0, 12000);
    const hash = crypto.createHash("sha256").update(text).digest("hex");
    const state = await loadMonitorState();
    const prev = state[url];
    state[url] = { hash, chars: text.length, seen_at: new Date().toISOString(), snippet: text.slice(0, 600) };
    const changed = prev && prev.hash !== hash;
    const saved = await saveMonitorState(state);
    if (!prev) {
      return `URL: ${url}\n\nBASELINE STORED — ${text.length} chars of page text snapshotted at ${state[url].seen_at}. Future checks will alert only when the page actually changes.${saved ? "" : "\n(Warning: state could not be saved — this snapshot is one-time only.)"}`;
    }
    if (!changed) {
      return `URL: ${url}\n\nNO CHANGE since ${prev.seen_at} (${text.length} chars checked).`;
    }
    const summary = await llm(SYSTEM, `This page changed since ${prev.seen_at}. Compare previous vs current and list concisely what is new or different.\n\nPREVIOUS SNIPPET:\n${prev.snippet}\n\nCURRENT CONTENT:\n${text}`);
    return `URL: ${url}\n\nCHANGED since ${prev.seen_at}:\n\n${summary}`;
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
  const port = parseInt(process.env.PORT || "8080", 10);
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, worker: WORKER_ID, uptime_s: Math.round(process.uptime()) }));
  }).listen(port, "0.0.0.0", () => log(`health endpoint listening on :${port}`));
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
