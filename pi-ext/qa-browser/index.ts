/**
 * sentinel-qa-browser — pi extension (v2 QA engine).
 *
 * Registers Playwright-backed browser tools so Mimo can drive QA inside pi's NATIVE
 * agent loop (full session memory + multi-tool reasoning), instead of the v1 Node loop.
 * Config comes from env (set by agents/qa.sh): QA_OUT, QA_BASE, QA_SAMPLE, QA_MAX_TOOLCALLS, QA_HEADLESS.
 * Tools only act on the localhost app under test; no fs/shell access (run pi with -nbt).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { chromium, type Browser, type Page } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = process.env.QA_OUT || "/tmp/qa-pi";
const BASE = process.env.QA_BASE || "http://127.0.0.1:3009";
const SAMPLE = process.env.QA_SAMPLE || "";
const MAX_CALLS = parseInt(process.env.QA_MAX_TOOLCALLS || "30", 10);
const HEADLESS = process.env.QA_HEADLESS !== "0";
// Optional login. Credentials come from env (set by qa.sh from config/sentinel.env); used ONLY to fill the
// form via Playwright — never sent to the model, never written to the trace/report/logs.
const LOGIN_EMAIL = process.env.QA_LOGIN_EMAIL || "";
const LOGIN_PASSWORD = process.env.QA_LOGIN_PASSWORD || "";
const LOGIN_PATH = process.env.QA_LOGIN_PATH || "/login";
const API_BASE = process.env.QA_API_BASE || ""; // backend API base for assertions (e.g. http://localhost:4000)
// Backend-auth capture is configurable so non-Supabase / non-"/api/" apps work too.
// QA_AUTH_URL_RE: JS regex matched against request URLs to sniff the app's own Authorization header
//   (default "/api/"; e.g. "api\\.myapp\\.com|/v1/" for an app whose API lives on another host/path).
// QA_AUTH_STORAGE_KEY: a localStorage key (substring) to read a bearer token from when no header was sniffed.
const AUTH_URL_RE: RegExp = (() => { try { return new RegExp(process.env.QA_AUTH_URL_RE || "/api/"); } catch { return /\/api\//; } })();
const AUTH_STORAGE_KEY = process.env.QA_AUTH_STORAGE_KEY || "";
fs.mkdirSync(OUT, { recursive: true });

let browser: Browser | null = null;
let page: Page | null = null;
const consoleErrors: string[] = [];
const pageErrors: string[] = [];
const failedRequests: string[] = [];
const bugs: { severity: string; desc: string; call: number }[] = [];
const trace: any[] = [];
let calls = 0;
let seenErr = 0;
let seenFail = 0;
let verdict = "";
let summary = "";
let reportWritten = false;
let loginAttempted = false;
let loginOk = true; // stays true when no login is configured
let capturedAuth = ""; // the real Authorization header the frontend sends to its API — reused for api_request

// Tag visible interactive elements (+ always file inputs) and return an indexed list.
// Mirrors v1 bin/qa-drive.js SNAP. Runs in the browser context.
function SNAP() {
  document.querySelectorAll("[data-qa-idx]").forEach((e) => e.removeAttribute("data-qa-idx"));
  const baseSel = 'a,button,input,select,textarea,label,[role=button],[role=link],[role=tab],[onclick],[contenteditable="true"],[tabindex],[draggable="true"]';
  const isVisible = (el: Element) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const st = getComputedStyle(el as HTMLElement);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
  };
  const seen = new Set<Element>();
  const cand: Element[] = [];
  document.querySelectorAll(baseSel).forEach((el) => { if (!seen.has(el)) { seen.add(el); cand.push(el); } });
  document.querySelectorAll("div,span,li").forEach((el) => {
    if (seen.has(el)) return;
    if (getComputedStyle(el as HTMLElement).cursor === "pointer" && isVisible(el)) { seen.add(el); cand.push(el); }
  });
  const out: any[] = []; let i = 0;
  for (const el of cand) {
    if (i >= 40) break;
    const isFile = el.tagName === "INPUT" && ((el.getAttribute("type") || "").toLowerCase() === "file");
    if (!isFile && !isVisible(el)) continue;
    el.setAttribute("data-qa-idx", String(i));
    let txt = ((el as any).innerText || (el as any).value || (el as HTMLElement).getAttribute("placeholder") || (el as HTMLElement).getAttribute("aria-label") || (el as HTMLElement).getAttribute("title") || (el as any).name || (el as any).type || "").trim().replace(/\s+/g, " ").slice(0, 70);
    if (isFile) txt = "[file upload] " + txt;
    out.push({ idx: i, tag: el.tagName.toLowerCase(), type: el.getAttribute("type") || "", text: txt || "(no text)" });
    i++;
  }
  return out;
}

async function ensurePage(): Promise<Page> {
  if (page) return page;
  browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 850 } });
  page = await ctx.newPage();
  // Cap the buffers so a noisy app (e.g. a wallet SDK reconnect loop) can't blow up the report or context.
  page.on("console", (m) => { if (m.type() === "error" && consoleErrors.length < 400) consoleErrors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => { if (pageErrors.length < 400) pageErrors.push((e.message || String(e)).slice(0, 300)); });
  page.on("requestfailed", (r) => { if (failedRequests.length < 400) { const f = r.failure(); failedRequests.push(`${r.method()} ${r.url().slice(0, 140)} — ${f ? f.errorText : "failed"}`); } });
  // Sniff the frontend's own API auth so api_request can authenticate exactly like the app does.
  page.on("request", (r) => { try { const a = r.headers()["authorization"]; if (a && AUTH_URL_RE.test(r.url())) capturedAuth = a; } catch {} });
  // Web3 dApp QA: inject an UNFUNDED burner wallet at window.ethereum (key stays in Node, txs are NEVER
  // broadcast) plus any gate stubs, BEFORE the first navigation so wagmi/ethers see the wallet at load.
  if (process.env.WEB3_ENABLED === "1") {
    try {
      const { installWeb3 } = await import("./web3");
      let stubs: any[] = [];
      try { stubs = process.env.WEB3_STUBS ? JSON.parse(process.env.WEB3_STUBS) : []; } catch { stubs = []; }
      const wlKey = process.env.WEB3_WL_KEY || "";
      stubs = stubs.map((s: any) => (s && s.whitelist ? { ...s, whitelistKey: wlKey } : s));
      const allowFunded = process.env.WEB3_ALLOW_FUNDED === "1";
      const { address } = await installWeb3(page, {
        rpcUrl: process.env.WEB3_RPC || "https://arb1.arbitrum.io/rpc",
        chainId: parseInt(process.env.WEB3_CHAIN_ID || "42161", 10),
        privateKey: process.env.WEB3_PK || undefined,
        allowFunded,
      }, stubs);
      // The ADDRESS is safe to record; the private KEY never leaves Node. allow_funded = a capped canary wallet
      // (broadcasts are still blocked — a real fill only happens if the app submits via its own backend).
      const kind = allowFunded ? "funded canary wallet" : "unfunded burner";
      trace.push({ n: 0, action: { type: "web3" }, observation: `injected ${kind} ${address} on chain ${process.env.WEB3_CHAIN_ID || "42161"} (txs never broadcast)`, result: allowFunded ? "no on-chain tx broadcast; cap the balance" : "no real funds can move", screenshot: "" });
    } catch (e: any) {
      const msg = String(e?.message || e);
      // A tripped safety guard (a FUNDED/used key) must HARD-ABORT — never drive a wallet that could move
      // money. Don't throw/close (that leaves a dead page the tools throw on): record the failure, write the
      // report, and exhaust the step budget so every tool short-circuits to "call finish now". No wallet was
      // injected, so nothing can be signed regardless.
      if (msg.includes("SENTINEL SAFETY ABORT")) {
        verdict = "fail"; summary = "SAFETY ABORT — " + msg.slice(0, 220);
        trace.push({ n: 0, action: { type: "web3" }, observation: summary, result: "run aborted; no wallet injected", screenshot: "" });
        calls = MAX_CALLS; writeReport();
      } else {
        trace.push({ n: 0, action: { type: "web3" }, observation: "web3 inject failed: " + msg.slice(0, 200), result: "", screenshot: "" });
      }
    }
  }
  // Seed localStorage UX-state keys (config-driven, generic) BEFORE the first navigation so the app reads
  // them at mount — e.g. suppress a first-visit onboarding/terms modal that would otherwise block the QA
  // agent. UX-STATE ONLY (never auth/token-shaped values); "_"-prefixed keys are treated as comments.
  // Contract: the config must be a plain object; string values are stored as-is, everything else is
  // JSON.stringify'd (what an app's own storage layer would persist) — never "[object Object]".
  if (process.env.QA_SEED_STORAGE) {
    try {
      const seed = JSON.parse(process.env.QA_SEED_STORAGE);
      const isPlainObject = !!seed && typeof seed === "object" && !Array.isArray(seed);
      const entries: [string, string][] = (isPlainObject ? Object.entries(seed) : [])
        .filter(([k]) => !k.startsWith("_"))
        .map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]);
      if (entries.length) {
        // Per-key try/catch inside the init script: one quota/security failure must not drop the
        // remaining keys. Seeding is attempted at document init; the trace records the attempt
        // (init scripts can't report back), so it says "seeding", not "seeded".
        await page.addInitScript((kv: [string, string][]) => {
          for (const [k, v] of kv) {
            try { window.localStorage.setItem(k, v); }
            // console.error is the one channel the driver already captures into the report's
            // consoleErrors — a quota/security failure surfaces there instead of vanishing.
            catch (e) { try { console.error(`sentinel seed_local_storage failed for "${k}": ${e}`); } catch {} }
          }
        }, entries);
        trace.push({ n: 0, action: { type: "seed_storage" }, observation: `seeding ${entries.length} localStorage key(s) at document init: ${entries.map(([k]) => k).join(", ")}`, result: "", screenshot: "" });
      }
    } catch { /* malformed QA_SEED_STORAGE — skip seeding */ }
  }
  if (LOGIN_EMAIL && LOGIN_PASSWORD) {
    loginAttempted = true; loginOk = false;
    const loginUrl = BASE.replace(/\/$/, "") + LOGIN_PATH;
    const emailSel = 'input[type="email"], input[name="email"], #email';
    const pwSel = 'input[type="password"], input[name="password"], #password';
    try {
      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForSelector(pwSel, { timeout: 15000 });
      await page.waitForTimeout(1500); // let React hydrate so controlled inputs keep their value
      await page.fill(emailSel, LOGIN_EMAIL, { timeout: 10000 });
      await page.fill(pwSel, LOGIN_PASSWORD, { timeout: 10000 });
      // Guard the hydration race: if a controlled input didn't keep the value, retype char-by-char.
      if ((await page.inputValue(emailSel).catch(() => "")) !== LOGIN_EMAIL) {
        await page.fill(emailSel, "").catch(() => {}); await page.type(emailSel, LOGIN_EMAIL, { delay: 25 });
      }
      if (!(await page.inputValue(pwSel).catch(() => ""))) {
        await page.type(pwSel, LOGIN_PASSWORD, { delay: 25 });
      }
      await Promise.all([
        page.waitForURL((u) => !u.toString().includes(LOGIN_PATH), { timeout: 25000 }).catch(() => {}),
        page.click('button[type="submit"]', { timeout: 10000 }),
      ]);
      await page.waitForTimeout(2500);
      loginOk = !page.url().includes(LOGIN_PATH);
      // Record only the OUTCOME + post-login URL — never the credentials.
      trace.push({ n: 0, action: { type: "login" }, observation: loginOk ? "logged in" : "LOGIN FAILED (still on login page)", result: page.url(), screenshot: "" });
    } catch (e: any) {
      trace.push({ n: 0, action: { type: "login" }, observation: "login error: " + String(e?.message || e).split("\n")[0].slice(0, 140), result: "", screenshot: "" });
    }
  } else {
    // Start on QA_START_PATH (default "/"). Useful when "/" depends on a backend we don't run (SSR fetch),
    // so QA begins on a client-rendered route (e.g. /trade) instead of a 500ing landing page.
    const startUrl = BASE.replace(/\/$/, "") + (process.env.QA_START_PATH || "/");
    try { await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30000 }); } catch {}
  }
  await page.waitForTimeout(1000);
  return page;
}

function drainErrors(): string {
  const all = consoleErrors.concat(pageErrors.map((e) => "pageerror: " + e));
  const ne = all.slice(seenErr); seenErr = all.length;
  const nf = failedRequests.slice(seenFail); seenFail = failedRequests.length;
  const lines = ne.concat(nf.map((f) => "request failed: " + f));
  if (!lines.length) return "";
  // Dedup + cap so a noisy app can't flood the model context (and inflate cost) with repeated errors.
  const seenK = new Set<string>(); const uniq: string[] = [];
  for (const l of lines) { const k = l.slice(0, 80); if (!seenK.has(k)) { seenK.add(k); uniq.push(l); } if (uniq.length >= 12) break; }
  const more = lines.length - uniq.length;
  return `\nNEW ERRORS (${lines.length} this step):\n` + uniq.map((l) => "- " + l).join("\n") + (more > 0 ? `\n- …(+${more} more, deduped)` : "");
}
function budgetNote(): string {
  return calls >= MAX_CALLS ? "\n\n[BUDGET REACHED — call `finish` now with your verdict.]" : "";
}
const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
// HARD budget gate — a soft nudge gets ignored; once the step budget is hit, action tools refuse so the
// agent must call finish() (bounds cost + keeps each flow inside the wall-clock cap).
const overBudgetMsg = () => text("STEP BUDGET EXHAUSTED — do NOT take more actions. Call finish() now with your verdict and a summary of what you found and what broke.");

function writeReport() {
  if (reportWritten) return;
  reportWritten = true;
  const seen = new Set<string>(); const deduped: any[] = [];
  for (const b of bugs) { const k = b.desc.toLowerCase().slice(0, 80); if (!seen.has(k)) { seen.add(k); deduped.push({ severity: b.severity, desc: b.desc, step: b.call }); } }
  const rank: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 };
  if (!verdict) verdict = deduped.some((b) => rank[b.severity] >= 2) ? "fail" : (deduped.length || pageErrors.length || consoleErrors.length || failedRequests.length) ? "issues" : "pass";
  if (!summary) summary = `${deduped.length} bug(s); ${consoleErrors.length} console error(s); ${failedRequests.length} failed request(s) across ${calls} tool call(s).`;
  const report = {
    engine: "pi-native", goal: process.env.QA_GOAL || "", base: BASE,
    steps: trace, bugs: deduped, consoleErrors, pageErrors, failedRequests,
    cost: "0", verdict, summary, model: process.env.QA_MODEL || "mimo-v2.5-pro",
    incomplete: false,
  };
  try { fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2)); } catch {}
  try { fs.writeFileSync(path.join(OUT, "report.html"), html(report)); } catch {}
}

function esc(s: any) { return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" } as any)[c]); }
function html(r: any) {
  const h: string[] = [];
  h.push('<!doctype html><meta charset="utf-8"><title>Sentinel QA (pi-native)</title>');
  h.push('<style>body{font:15px/1.55 system-ui;margin:24px;max-width:1000px;background:#0d0d0f;color:#e8e8ea}img{max-width:100%;border:1px solid #2a2a30;border-radius:8px}h1,h2{border-bottom:1px solid #2a2a30;padding-bottom:6px}.v{display:inline-block;padding:3px 10px;border-radius:6px;font-weight:600}.pass{background:#0f3d1f;color:#7ee29a}.issues{background:#3d320f;color:#e2cb7e}.fail{background:#3d1414;color:#e28a8a}.sev{font-weight:700}.critical,.high{color:#ff8a8a}.medium{color:#ffd27e}.low{color:#9aa}.step{border:1px solid #2a2a30;border-radius:10px;padding:10px 14px;margin:12px 0}.muted{color:#9aa}code{background:#1a1a1f;padding:1px 5px;border-radius:4px}</style>');
  h.push(`<h1>🤖 Sentinel QA <span class="muted">(pi-native / Mimo agent)</span> <span class="v ${esc(r.verdict)}">${esc(r.verdict)}</span></h1>`);
  h.push(`<p class="muted">${esc(r.base)} • ${esc(r.model)} • ${r.steps.length} tool calls</p>`);
  h.push(`<p><b>Goal:</b> ${esc(r.goal)}</p><p><b>Summary:</b> ${esc(r.summary)}</p>`);
  h.push("<h2>Bugs (" + r.bugs.length + ")</h2>");
  if (r.bugs.length) { h.push("<ul>"); for (const b of r.bugs) h.push(`<li><span class="sev ${esc(b.severity)}">[${esc(b.severity)}]</span> ${esc(b.desc)}</li>`); h.push("</ul>"); } else h.push('<p class="muted">None.</p>');
  if (r.consoleErrors.length) { h.push("<h2>Console errors</h2><ul>"); for (const e of r.consoleErrors.slice(0, 30)) h.push("<li><code>" + esc(e) + "</code></li>"); h.push("</ul>"); }
  if (r.failedRequests.length) { h.push("<h2>Failed requests</h2><ul>"); for (const e of r.failedRequests.slice(0, 30)) h.push("<li><code>" + esc(e) + "</code></li>"); h.push("</ul>"); }
  h.push("<h2>Tool trace</h2>");
  for (const s of r.steps) {
    h.push('<div class="step">');
    h.push(`<b>#${s.n}</b> <code>${esc(s.action?.type)}${s.action?.index != null ? " #" + s.action.index : ""}</code> <span class="muted">${esc(s.observation || "")}</span>`);
    if (s.result) h.push(`<p class="muted">→ ${esc(s.result)}</p>`);
    if (s.screenshot) h.push(`<img loading="lazy" src="${esc(s.screenshot)}">`);
    h.push("</div>");
  }
  return h.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "browser_snapshot",
    label: "Snapshot",
    description: "Observe the page. Returns URL, title, a numbered list of interactive elements (use the number as 'index' for click/type/upload), and any new console/page/network errors since the last snapshot. Call this first, and again after each action to see what changed.",
    parameters: Type.Object({}),
    async execute() {
      const p = await ensurePage(); if (calls >= MAX_CALLS) return overBudgetMsg(); calls++;
      let els: any[] = [];
      try { els = await p.evaluate(SNAP); } catch (e: any) { return text("page unavailable: " + String(e?.message || e).split("\n")[0].slice(0, 160) + " — call finish now with your verdict."); }
      const url = p.url(); let title = ""; try { title = await p.title(); } catch {}
      if (loginAttempted && !loginOk && url.includes(LOGIN_PATH)) {
        return text(`AUTO-LOGIN FAILED — you are on the login page and you do NOT have credentials to log in yourself. Do NOT fill or submit the login form. Call \`finish\` now with verdict "fail" and summary "automated login failed".`);
      }
      const shot = `step-${String(calls).padStart(2, "0")}.png`;
      try { await p.screenshot({ path: path.join(OUT, shot) }); } catch {}
      trace.push({ n: calls, url, action: { type: "snapshot" }, observation: `${url} — ${title}`, result: `${els.length} elements`, screenshot: shot });
      const list = els.map((e) => `${e.idx}) <${e.tag}${e.type ? " type=" + e.type : ""}> ${e.text}`).join("\n") || "(no interactive elements)";
      return text(`URL: ${url}\nTITLE: ${title}\nELEMENTS:\n${list}${drainErrors()}${budgetNote()}`);
    },
  });

  pi.registerTool({
    name: "browser_click", label: "Click",
    description: "Click the element with the given index from the latest browser_snapshot.",
    parameters: Type.Object({ index: Type.Number({ description: "element index" }) }),
    async execute(_id, params: any) {
      const p = await ensurePage(); if (calls >= MAX_CALLS) return overBudgetMsg(); calls++;
      let result: string;
      try { await p.click(`[data-qa-idx="${params.index}"]`, { timeout: 8000 }); result = "clicked #" + params.index; }
      catch (e: any) { result = "click failed: " + String(e?.message || e).split("\n")[0].slice(0, 160); }
      await p.waitForTimeout(800);
      trace.push({ n: calls, action: { type: "click", index: params.index }, observation: "", result });
      return text(result + drainErrors() + budgetNote());
    },
  });

  pi.registerTool({
    name: "browser_type", label: "Type",
    description: "Type text into the input/textarea with the given index (clears it first).",
    parameters: Type.Object({ index: Type.Number(), text: Type.String() }),
    async execute(_id, params: any) {
      const p = await ensurePage(); if (calls >= MAX_CALLS) return overBudgetMsg(); calls++;
      let result: string;
      try { await p.fill(`[data-qa-idx="${params.index}"]`, params.text ?? "", { timeout: 8000 }); result = `typed into #${params.index}`; }
      catch (e: any) { result = "type failed: " + String(e?.message || e).split("\n")[0].slice(0, 160); }
      trace.push({ n: calls, action: { type: "type", index: params.index }, observation: "", result });
      return text(result + drainErrors() + budgetNote());
    },
  });

  pi.registerTool({
    name: "browser_upload", label: "Upload",
    description: "Attach the sample image file to the file-input with the given index (works even if the input is visually hidden behind a label/dropzone).",
    parameters: Type.Object({ index: Type.Number() }),
    async execute(_id, params: any) {
      const p = await ensurePage(); if (calls >= MAX_CALLS) return overBudgetMsg(); calls++;
      let result: string;
      if (!SAMPLE || !fs.existsSync(SAMPLE)) result = "upload: no sample image configured";
      else { try { await p.setInputFiles(`[data-qa-idx="${params.index}"]`, SAMPLE, { timeout: 8000 }); result = `uploaded sample to #${params.index}`; } catch (e: any) { result = "upload failed: " + String(e?.message || e).split("\n")[0].slice(0, 160); } }
      await p.waitForTimeout(800);
      trace.push({ n: calls, action: { type: "upload", index: params.index }, observation: "", result });
      return text(result + drainErrors() + budgetNote());
    },
  });

  pi.registerTool({
    name: "browser_navigate", label: "Navigate",
    description: "Navigate to a path/URL WITHIN this app (same origin only). Cross-origin navigation is blocked (it loses your session).",
    parameters: Type.Object({ url: Type.String() }),
    async execute(_id, params: any) {
      const p = await ensurePage(); if (calls >= MAX_CALLS) return overBudgetMsg(); calls++;
      let result: string;
      try {
        const target = new URL(params.url, BASE);
        const baseOrigin = new URL(BASE).origin;
        if (target.origin !== baseOrigin) {
          result = `blocked: stay within the app at ${baseOrigin} — not navigating to ${target.origin} (a different origin loses your login session)`;
        } else {
          await p.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 30000 });
          result = "navigated to " + target.toString();
        }
      } catch (e: any) { result = "navigate failed: " + String(e?.message || e).split("\n")[0].slice(0, 160); }
      trace.push({ n: calls, action: { type: "navigate" }, observation: params.url, result });
      return text(result + drainErrors() + budgetNote());
    },
  });

  pi.registerTool({
    name: "browser_scroll", label: "Scroll",
    description: "Scroll the page down one viewport to reveal more content.",
    parameters: Type.Object({}),
    async execute() {
      const p = await ensurePage(); if (calls >= MAX_CALLS) return overBudgetMsg(); calls++;
      try { await p.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.85))); } catch {}
      trace.push({ n: calls, action: { type: "scroll" }, observation: "", result: "scrolled" });
      return text("scrolled" + drainErrors() + budgetNote());
    },
  });

  pi.registerTool({
    name: "report_bug", label: "Report bug",
    description: "Record a real defect you found (broken UI, JS/console error, dead control, failed/stuck request, wrong content). Only real defects.",
    parameters: Type.Object({
      severity: Type.String({ description: "low | medium | high | critical" }),
      description: Type.String({ description: "concrete, specific bug description" }),
    }),
    async execute(_id, params: any) {
      bugs.push({ severity: String(params.severity || "low").toLowerCase(), desc: String(params.description || "").slice(0, 300), call: calls });
      return text(`recorded bug (${bugs.length} total)`);
    },
  });

  pi.registerTool({
    name: "api_request", label: "API request",
    description: "Call the app's BACKEND API to verify SERVER-SIDE state — e.g. GET back a record you just created/changed via the UI to confirm it persisted correctly, or check a status transition. Uses your logged-in session. This is how you assert BACKEND correctness, not just what the UI shows.",
    parameters: Type.Object({
      method: Type.String({ description: "GET | POST | PUT | PATCH | DELETE" }),
      path: Type.String({ description: "API path, e.g. /api/reservations/<id> (relative to the API base)" }),
      body: Type.String({ description: "optional JSON body for POST/PUT/PATCH (empty string if none)" }),
    }),
    async execute(_id, params: any) {
      const p = await ensurePage(); if (calls >= MAX_CALLS) return overBudgetMsg(); calls++;
      if (!API_BASE) return text("api_request unavailable: no backend API base configured for this target.");
      const rawPath = String(params.path || "");
      const readOnly = process.env.QA_API_READONLY === "1";
      const method = String(params.method || "GET").toUpperCase();
      // pr-qa (QA_API_READONLY=1): the DOM is attacker-controlled PR code. Two confinements:
      // (1) only GET — no prompt-injected mutation; (2) NO absolute URLs — an absolute rawPath
      // would escape API_BASE (pinned to the preview's own origin) and let injection probe
      // loopback/private hosts. Force every call relative, so it can only ever hit the preview.
      if (readOnly && method !== "GET") {
        return text(`api_request refused: only GET is permitted in PR-preview QA mode (attempted ${method}).`);
      }
      if (readOnly && /^https?:/i.test(rawPath)) {
        return text("api_request refused: absolute URLs are not allowed in PR-preview QA mode — use a path relative to the preview's own API.");
      }
      const url = (!readOnly && /^https?:/.test(rawPath)) ? rawPath : API_BASE.replace(/\/$/, "") + (rawPath.startsWith("/") ? "" : "/") + rawPath;
      const body = params.body && String(params.body).trim() ? String(params.body) : undefined;
      // SECURITY: only forward the app's bearer to a TRUSTED ORIGIN — the API base origin or the page's own
      // origin. A model-supplied absolute URL to any other host gets no token (the capture regex is for
      // sniffing the app's own traffic, NOT a forwarding allowlist — "/api/" would match evil.tld/api/...).
      const allowAuth = (() => {
        try {
          const dest = new URL(url).origin;
          const apiOrigin = API_BASE ? new URL(API_BASE).origin : "";
          let pageOrigin = ""; try { pageOrigin = new URL(BASE).origin; } catch {}
          return (!!apiOrigin && dest === apiOrigin) || (!!pageOrigin && dest === pageOrigin);
        } catch { return false; }
      })();
      let res: any;
      try {
        // fetch from INSIDE the page → inherits the app origin + auth. Prefer the sniffed header; else read a
        // bearer token from localStorage (configured key first, then the Supabase default shape). Bearer is
        // attached ONLY when allowAuth (trusted destination); cookies (credentials:include) are origin-scoped anyway.
        res = await p.evaluate(async ({ url, method, body, auth, storageKey, allowAuth }: any) => {
          let authHeader = allowAuth ? (auth || "") : "";
          if (!authHeader && allowAuth) {
            // Pull an access token out of common localStorage shapes (Supabase, Zustand-persist, plain JWT).
            const pickTok = (raw: string | null): string => {
              if (!raw) return "";
              try {
                const v: any = JSON.parse(raw);
                return v.access_token || v.accessToken || v.token
                  || (v.currentSession && v.currentSession.access_token)
                  || (v.state && (v.state.accessToken || v.state.access_token
                       || (v.state.tokens && (v.state.tokens.accessToken || v.state.tokens.access_token)))) || "";
              } catch { return /^[\w-]+\.[\w-]+\.[\w-]+$/.test(raw) ? raw : ""; } // bare JWT string
            };
            try {
              let tok = "";
              if (storageKey) { // exact key first, then substring match
                const k = localStorage.getItem(storageKey) != null ? storageKey : Object.keys(localStorage).find((x) => x.includes(storageKey));
                if (k) tok = pickTok(localStorage.getItem(k));
              }
              if (!tok) { const k = Object.keys(localStorage).find((x) => x.startsWith("sb-") && x.endsWith("-auth-token")); if (k) tok = pickTok(localStorage.getItem(k)); }
              if (tok) authHeader = "Bearer " + tok;
            } catch {}
          }
          const headers: any = { "Content-Type": "application/json" };
          if (authHeader) headers["Authorization"] = authHeader;
          // In read-only PR mode don't FOLLOW redirects: a preview-origin GET that 302s to an
          // internal host would otherwise be chased by fetch, escaping the origin confinement.
          const r = await fetch(url, { method, headers, body, credentials: "include", redirect: readOnly ? "manual" : "follow" });
          const t = await r.text();
          return { status: r.status, body: t.slice(0, 2500) };
        }, { url, method, body, auth: capturedAuth, storageKey: AUTH_STORAGE_KEY, allowAuth });
      } catch (e: any) { res = { status: 0, body: "request failed: " + (e?.message || e) }; }
      trace.push({ n: calls, action: { type: "api" }, observation: `${method} ${rawPath} → ${res.status}`, result: String(res.body).slice(0, 200) });
      return text(`API ${method} ${url} → HTTP ${res.status}\n${res.body}${budgetNote()}`);
    },
  });

  pi.registerTool({
    name: "finish", label: "Finish",
    description: "End the QA run. Provide an overall verdict and a 2-3 sentence summary for a developer.",
    parameters: Type.Object({
      verdict: Type.String({ description: "pass | issues | fail" }),
      summary: Type.String(),
    }),
    async execute(_id, params: any) {
      verdict = String(params.verdict || "").toLowerCase() || verdict;
      summary = String(params.summary || "") || summary;
      writeReport();
      return text("QA report written. You may stop now.");
    },
  });

  // Fallbacks: always emit a report and release the browser, even if the model never calls finish.
  pi.on("agent_end", async () => { writeReport(); });
  pi.on("session_shutdown", async () => { writeReport(); try { await browser?.close(); } catch {} });
}
