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
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => pageErrors.push((e.message || String(e)).slice(0, 300)));
  page.on("requestfailed", (r) => { const f = r.failure(); failedRequests.push(`${r.method()} ${r.url().slice(0, 140)} — ${f ? f.errorText : "failed"}`); });
  // Sniff the frontend's own API auth so api_request can authenticate exactly like the app does.
  page.on("request", (r) => { try { const a = r.headers()["authorization"]; if (a && /\/api\//.test(r.url())) capturedAuth = a; } catch {} });
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
    try { await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 }); } catch {}
  }
  await page.waitForTimeout(1000);
  return page;
}

function drainErrors(): string {
  const all = consoleErrors.concat(pageErrors.map((e) => "pageerror: " + e));
  const ne = all.slice(seenErr); seenErr = all.length;
  const nf = failedRequests.slice(seenFail); seenFail = failedRequests.length;
  const lines = ne.concat(nf.map((f) => "request failed: " + f));
  return lines.length ? "\nNEW ERRORS:\n" + lines.map((l) => "- " + l).join("\n") : "";
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
      const els: any[] = await p.evaluate(SNAP);
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
      const url = /^https?:/.test(rawPath) ? rawPath : API_BASE.replace(/\/$/, "") + (rawPath.startsWith("/") ? "" : "/") + rawPath;
      const method = String(params.method || "GET").toUpperCase();
      const body = params.body && String(params.body).trim() ? String(params.body) : undefined;
      let res: any;
      try {
        // fetch from INSIDE the page → inherits the app origin + auth (Supabase JWT in localStorage).
        res = await p.evaluate(async ({ url, method, body, auth }: any) => {
          let authHeader = auth || "";
          if (!authHeader) { try { const k = Object.keys(localStorage).find((x) => x.startsWith("sb-") && x.endsWith("-auth-token")); if (k) { const v = JSON.parse(localStorage.getItem(k)); const tok = v.access_token || (v.currentSession && v.currentSession.access_token) || ""; if (tok) authHeader = "Bearer " + tok; } } catch {} }
          const headers: any = { "Content-Type": "application/json" };
          if (authHeader) headers["Authorization"] = authHeader;
          const r = await fetch(url, { method, headers, body, credentials: "include" });
          const t = await r.text();
          return { status: r.status, body: t.slice(0, 2500) };
        }, { url, method, body, auth: capturedAuth });
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
