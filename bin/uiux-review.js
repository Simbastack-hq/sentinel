#!/usr/bin/env node
/* uiux-review.js — VISION-based UI/UX review using Xiaomi mimo-v2-omni (multimodal).
 * Reads a qa report.json (steps[].url + .screenshot), dedupes to key screens, and runs a structured
 * UI/UX design rubric over each screenshot in parallel. Writes uiux.json + prints a one-line summary.
 * This is the design/usability lens (what the functional DOM-based QA can't see).
 * Usage: uiux-review.js --report <report.json> --out <dir> [--app "name"] [--max-screens N]
 */
const fs = require('fs'); const os = require('os'); const path = require('path');

// Provider-agnostic: any OpenAI-compatible vision endpoint (Xiaomi/Mimo by default, or OpenRouter, etc.).
// VISION_* are the generic knobs; XIAOMI_*/MIMO_* are kept as back-compat aliases.
const DEFAULT_BASE = 'https://api.xiaomimimo.com/v1';
const BASE = process.env.VISION_BASE_URL || process.env.XIAOMI_BASE_URL || DEFAULT_BASE;
const IS_DEFAULT_BASE = BASE === DEFAULT_BASE;
// On a non-default base there's no safe implicit model — require VISION_MODEL (validated below).
const MODEL = process.env.VISION_MODEL || process.env.MIMO_VISION_MODEL || (IS_DEFAULT_BASE ? 'mimo-v2-omni' : '');
const MAXTOK = parseInt(process.env.MIMO_VISION_MAXTOK || '6000', 10); // omni reasons HEAVILY before emitting JSON — needs lots of room or it cuts off mid-thought
const TIMEOUT = (parseInt(process.env.MIMO_VISION_TIMEOUT || '150', 10)) * 1000;
const CONCURRENCY = parseInt(process.env.UIUX_CONCURRENCY || '3', 10);
// Optional attribution headers (OpenRouter uses these for ranking; harmless elsewhere).
const EXTRA_HEADERS = {};
if (process.env.VISION_HTTP_REFERER) EXTRA_HEADERS['HTTP-Referer'] = process.env.VISION_HTTP_REFERER;
if (process.env.VISION_TITLE) EXTRA_HEADERS['X-Title'] = process.env.VISION_TITLE;

function getKey() {
  if (process.env.VISION_API_KEY) return process.env.VISION_API_KEY;
  if (!IS_DEFAULT_BASE) return ''; // never send Xiaomi creds to a non-Xiaomi endpoint — require VISION_API_KEY there
  if (process.env.XIAOMI_API_KEY) return process.env.XIAOMI_API_KEY;
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.pi/agent/auth.json'), 'utf8')).xiaomi.key; } catch { return ''; }
}
function parseArgs() {
  const o = { maxScreens: 8, app: 'this app' }; const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--report') o.report = a[++i]; else if (a[i] === '--out') o.out = a[++i];
    else if (a[i] === '--app') o.app = a[++i]; else if (a[i] === '--max-screens') o.maxScreens = parseInt(a[++i], 10) || 8;
  }
  return o;
}
function extractJson(t) {
  if (!t) return null;
  t = t.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
  try { return JSON.parse(t); } catch {}
  for (let s = t.indexOf('{'); s >= 0; s = t.indexOf('{', s + 1)) {
    let d = 0, instr = false, esc = false;
    for (let j = s; j < t.length; j++) { const c = t[j];
      if (instr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') instr = false; }
      else if (c === '"') instr = true; else if (c === '{') d++;
      else if (c === '}') { if (--d === 0) { try { return JSON.parse(t.slice(s, j + 1)); } catch {} break; } } }
  }
  return null;
}
const RUBRIC = (app, screen) => `You are a senior UI/UX designer doing a rigorous design review of ONE screen of "${app}" (screen: ${screen}). Look ONLY at this screenshot and judge it on: visual hierarchy, layout/spacing/alignment, typography, color & CONTRAST (flag hard-to-read or likely-WCAG-fail text), consistency, usability & affordances (Nielsen heuristics), state handling (empty/loading/error), and information density.
Report ONLY real, specific design/usability issues a designer would act on — NOT functional bugs, NOT nitpicks. If the screen is genuinely well-designed, return an empty findings array.
Return ONLY JSON (no prose, no markdown fences):
{"summary":"<one-line overall design impression>","findings":[{"dimension":"hierarchy|spacing|typography|color-contrast|consistency|usability|state|density","severity":"low|medium|high","title":"<short>","detail":"<specific observation about THIS screen>","recommendation":"<concrete fix>"}]}`;

async function reviewScreen(app, screen, imgPath) {
  const mime = /\.jpe?g$/i.test(imgPath) ? 'image/jpeg' : 'image/png';
  const b64 = fs.readFileSync(imgPath).toString('base64');
  const body = { model: MODEL, max_tokens: MAXTOK, messages: [{ role: 'user', content: [
    { type: 'text', text: RUBRIC(app, screen) },
    { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }] }] };
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  let tokens = 0, parsed = { summary: '', findings: [] }, failed = false;
  try {
    const r = await fetch(`${BASE}/chat/completions`, { method: 'POST',
      headers: { Authorization: `Bearer ${getKey()}`, 'Content-Type': 'application/json', ...EXTRA_HEADERS },
      body: JSON.stringify(body), signal: ctrl.signal });
    const d = await r.json();
    tokens = (d.usage && d.usage.total_tokens) || 0;
    // SAY SO when the API refuses. A text-only model 404s every image request; without this the
    // catch below never fires, parsed stays empty, and the run logs "0 finding(s), 0 tok" — which
    // reads as "reviewed it, all clean" rather than "never ran". That hid a dead vision pass for
    // weeks (VISION_MODEL was pointed at xiaomi/mimo-v2.5-pro, which has no image input).
    if (!r.ok || d.error) {
      const msg = (d.error && (d.error.message || JSON.stringify(d.error))) || `HTTP ${r.status}`;
      throw new Error(`${MODEL} rejected the image request: ${String(msg).slice(0, 160)}`);
    }
    const c = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    const j = extractJson(c);
    if (j) parsed = j;
  } catch (e) { parsed = { summary: 'review failed: ' + e.message, findings: [] }; failed = true; }
  clearTimeout(timer);
  const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
  console.error(failed
    ? `  FAILED ${screen} — ${parsed.summary}`
    : `  reviewed ${screen} — ${findings.length} finding(s), ${tokens} tok`);
  return { screen, screenshot: path.basename(imgPath), summary: parsed.summary || '', findings, tokens };
}
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); } }));
  return out;
}

(async () => {
  const o = parseArgs();
  if (!o.report || !o.out) { console.error('usage: uiux-review --report <report.json> --out <dir>'); process.exit(2); }
  if (!!process.env.VISION_API_KEY !== !!process.env.VISION_BASE_URL) { console.error('uiux-review: set VISION_API_KEY and VISION_BASE_URL together (they pair as one provider)'); process.exit(3); }
  if (!getKey()) { console.error('uiux-review: no vision API key (set VISION_API_KEY for a custom VISION_BASE_URL, else XIAOMI_API_KEY or ~/.pi/agent/auth.json)'); process.exit(3); }
  if (!MODEL) { console.error('uiux-review: set VISION_MODEL when using a non-default VISION_BASE_URL'); process.exit(3); }
  let rep; try { rep = JSON.parse(fs.readFileSync(o.report, 'utf8')); } catch { console.error('uiux-review: bad report.json'); process.exit(2); }
  // Distinct screens by URL path; representative shot = the LAST snapshot of that screen.
  const byScreen = new Map();
  for (const s of (rep.steps || [])) {
    if (!s.screenshot) continue;
    let key = s.url || s.screenshot; try { key = new URL(s.url).pathname; } catch {}
    const img = path.join(o.out, s.screenshot);
    if (fs.existsSync(img)) byScreen.set(key, { screen: key, img });
  }
  const screens = [...byScreen.values()].slice(0, o.maxScreens);
  if (!screens.length) { fs.writeFileSync(path.join(o.out, 'uiux.json'), JSON.stringify({ app: o.app, screens: [], totalFindings: 0, tokens: 0, model: MODEL }, null, 2)); console.log('UIUX 0 screens'); process.exit(0); }
  console.error(`uiux-review: ${screens.length} screen(s) via ${MODEL}...`);
  const results = await pool(screens, CONCURRENCY, (s) => reviewScreen(o.app, s.screen, s.img));
  const rank = { high: 2, medium: 1, low: 0 };
  for (const r of results) r.findings.sort((a, b) => (rank[b.severity] || 0) - (rank[a.severity] || 0));
  const totalFindings = results.reduce((a, r) => a + r.findings.length, 0);
  const tokens = results.reduce((a, r) => a + (r.tokens || 0), 0);
  fs.writeFileSync(path.join(o.out, 'uiux.json'), JSON.stringify({ app: o.app, screens: results, totalFindings, tokens, model: MODEL }, null, 2));
  console.log(`UIUX ${results.length} screens, ${totalFindings} findings, ${tokens} tokens`);
  process.exit(0);
})();
