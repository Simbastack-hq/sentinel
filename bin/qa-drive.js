#!/usr/bin/env node
/* qa-drive.js — agentic QA loop. Mimo (via pi) reads the live DOM each step and
 * picks the next action; Playwright executes it on a 127.0.0.1 dev server. Collects
 * console/page/network errors + screenshots, then writes report.json + report.html.
 * Read-only against the app (no repo writes). Resolve Playwright via NODE_PATH (set by qa.sh).
 *
 * Usage: qa-drive.js --base URL --out DIR --steps N --goal "..." [--provider P --model M
 *        --thinking T --headless 1 --sample IMG --pi-timeout 120]
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function parseArgs(argv) {
  const o = { provider: 'xiaomi', model: 'mimo-v2.5-pro', thinking: 'medium', headless: '1', steps: 10, piTimeout: 120, sample: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === '--base') o.base = v(); else if (a === '--out') o.out = v();
    else if (a === '--steps') { const n = parseInt(v(), 10); o.steps = Number.isFinite(n) && n > 0 ? n : 10; } else if (a === '--goal') o.goal = v();
    else if (a === '--provider') o.provider = v(); else if (a === '--model') o.model = v();
    else if (a === '--thinking') o.thinking = v(); else if (a === '--headless') o.headless = v();
    else if (a === '--sample') o.sample = v(); else if (a === '--pi-timeout') o.piTimeout = parseInt(v(), 10) || 120;
  }
  return o;
}

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { console.error('qa-drive: playwright not resolvable — run `cd ~/sentinel && npm install`'); process.exit(3); }

// ---- pi / Mimo ----
function parsePiStream(stdout) {
  let text = '', cost = 0;
  for (const line of stdout.split('\n')) {
    const s = line.trim(); if (!s || s[0] !== '{') continue;
    let ev; try { ev = JSON.parse(s); } catch { continue; }
    const pick = (msg) => {
      if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) return;
      const t = msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
      if (t) text = t;
      const tot = msg.usage && msg.usage.cost && msg.usage.cost.total;
      if (tot != null) cost = tot;
    };
    if (ev.type === 'agent_end' && Array.isArray(ev.messages)) ev.messages.forEach(pick);
    else if (ev.message) pick(ev.message);
  }
  return { text: text.trim(), cost };
}
function askMimo(opts, prompt) {
  return new Promise((resolve) => {
    const args = ['-p', '-nt', '--no-session', '--mode', 'json', '--provider', opts.provider,
      '--model', opts.model, '--thinking', opts.thinking, prompt];
    const child = spawn('pi', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.piTimeout * 1000);
    child.stdout.on('data', (d) => (out += d));
    // ok=false is distinguishable from a real "done" so the loop won't end the run prematurely.
    child.on('error', () => { clearTimeout(timer); resolve({ text: '', cost: 0, ok: false, error: 'pi spawn error' }); });
    child.on('close', () => {
      clearTimeout(timer);
      const r = parsePiStream(out);
      resolve({ ...r, ok: !timedOut && !!r.text, error: timedOut ? 'pi timeout' : (r.text ? null : 'empty/unparseable response') });
    });
  });
}
// Extract the first BALANCED JSON object, tolerating surrounding prose / fences / stray braces.
function extractJson(text) {
  if (!text) return null;
  let t = text.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
  try { return JSON.parse(t); } catch {}
  for (let i = t.indexOf('{'); i >= 0; i = t.indexOf('{', i + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < t.length; j++) {
      const c = t[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
      else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { if (--depth === 0) { try { return JSON.parse(t.slice(i, j + 1)); } catch {} break; } }
    }
  }
  return null;
}

// ---- DOM snapshot: tag interactive elements, return an indexed list ----
// Surfaces standard controls, <label>s, custom cursor:pointer "dropzones", and file
// inputs even when visually hidden (the common label+hidden-input upload pattern).
const SNAP = () => {
  document.querySelectorAll('[data-qa-idx]').forEach((e) => e.removeAttribute('data-qa-idx'));
  const baseSel = 'a,button,input,select,textarea,label,[role=button],[role=link],[role=tab],[onclick],[contenteditable="true"],[tabindex],[draggable="true"]';
  const isVisible = (el) => {
    const r = el.getBoundingClientRect(); const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  };
  const seen = new Set(); const cand = [];
  document.querySelectorAll(baseSel).forEach((el) => { if (!seen.has(el)) { seen.add(el); cand.push(el); } });
  // Custom clickables (styled div/span/li with a pointer cursor) — catches bespoke dropzones/tiles.
  document.querySelectorAll('div,span,li').forEach((el) => {
    if (seen.has(el)) return;
    if (getComputedStyle(el).cursor === 'pointer' && isVisible(el)) { seen.add(el); cand.push(el); }
  });
  const out = []; let i = 0;
  for (const el of cand) {
    if (i >= 40) break;
    const isFile = el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'file';
    if (!isFile && !isVisible(el)) continue; // always surface file inputs (often hidden behind a label)
    el.setAttribute('data-qa-idx', String(i));
    let txt = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.getAttribute('title') || el.name || el.type || '').trim().replace(/\s+/g, ' ').slice(0, 70);
    if (isFile) txt = '[file upload] ' + txt;
    out.push({ idx: i, tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', text: txt || '(no text)' });
    i++;
  }
  return out;
};

function buildPrompt(o, ctx) {
  const list = ctx.els.map((e) => `${e.idx}) <${e.tag}${e.type ? ' type=' + e.type : ''}> ${e.text || '(no text)'}`).join('\n') || '(no interactive elements found)';
  return `You are an autonomous QA tester driving a real web app in a browser. Find bugs.

GOAL: ${o.goal}

STEP ${ctx.n} of ${o.steps}
URL: ${ctx.url}
TITLE: ${ctx.title}
${ctx.lastResult ? 'LAST ACTION RESULT: ' + ctx.lastResult + '\n' : ''}${ctx.newErrors.length ? 'NEW CONSOLE/PAGE ERRORS SINCE LAST STEP:\n' + ctx.newErrors.map((e) => '- ' + e).join('\n') + '\n' : ''}
INTERACTIVE ELEMENTS (use the index for click/type/upload):
${list}

Reply with ONLY a compact JSON object, no prose, no markdown:
{"observation":"what you see / what just happened (1 sentence)","bugs":[{"severity":"low|medium|high|critical","desc":"concrete bug"}],"action":{"type":"click|type|upload|navigate|scroll|press|wait|done","index":<int or null>,"text":<string or null>,"url":<string or null>,"key":<string or null>},"done":false}

Rules: bugs = ONLY real defects (JS errors, broken UI, dead controls, failed/stuck requests, wrong content); [] if none this step. "type" fills a text input (needs index+text). "upload" sets a file on a file input (needs index). Pick actions that exercise the GOAL. Set done=true (or action.type "done") when the goal is covered or you are stuck.`;
}

async function executeAction(page, a, sample) {
  const sel = a.index != null ? `[data-qa-idx="${a.index}"]` : null;
  try {
    switch ((a.type || '').toLowerCase()) {
      case 'click': if (!sel) return 'click: no index'; await page.click(sel, { timeout: 8000 }); return 'clicked #' + a.index;
      case 'type': if (!sel) return 'type: no index'; await page.fill(sel, a.text || '', { timeout: 8000 }); return `typed into #${a.index}`;
      case 'upload':
        if (!sel) return 'upload: no index';
        if (!sample || !fs.existsSync(sample)) return 'upload: no sample image available';
        await page.setInputFiles(sel, sample, { timeout: 8000 }); return `uploaded sample to #${a.index}`;
      case 'navigate': if (!a.url) return 'navigate: no url'; await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 30000 }); return 'navigated ' + a.url;
      case 'scroll': await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.85))); return 'scrolled';
      case 'press': await page.keyboard.press(a.key || 'Enter'); return 'pressed ' + (a.key || 'Enter');
      case 'wait': await page.waitForTimeout(2000); return 'waited';
      case 'done': return 'done';
      default: return 'unknown action: ' + a.type;
    }
  } catch (e) { return 'ACTION FAILED: ' + (e.message || e).split('\n')[0].slice(0, 160); }
}

(async () => {
  const o = parseArgs(process.argv.slice(2));
  if (!o.base || !o.out || !o.goal) { console.error('usage: qa-drive --base URL --out DIR --goal "..." [--steps N]'); process.exit(2); }
  fs.mkdirSync(o.out, { recursive: true });

  const consoleErrors = [], pageErrors = [], failedRequests = [];
  const steps = [], allBugs = [];
  let totalCost = 0, lastResult = '', seenErr = 0, seenFail = 0, modelError = null;
  let bugs = [], verdict = 'pass', summary = '';
  const rank = { critical: 3, high: 2, medium: 1, low: 0 };

  const browser = await chromium.launch({ headless: o.headless !== '0' });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
    page.on('pageerror', (e) => pageErrors.push((e.message || String(e)).slice(0, 300)));
    page.on('requestfailed', (r) => { const f = r.failure(); failedRequests.push(`${r.method()} ${r.url().slice(0, 140)} — ${f ? f.errorText : 'failed'}`); });

    try { await page.goto(o.base, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
    catch (e) { lastResult = 'initial load FAILED: ' + e.message; }
    await page.waitForTimeout(1200);

    for (let n = 1; n <= o.steps; n++) {
      let els = [];
      try { els = await page.evaluate(SNAP); } catch {}
      const allErr = consoleErrors.concat(pageErrors.map((e) => 'pageerror: ' + e));
      const newErr = allErr.slice(seenErr); seenErr = allErr.length;
      const newFail = failedRequests.slice(seenFail); seenFail = failedRequests.length;
      const newErrors = newErr.concat(newFail.map((f) => 'request failed: ' + f)); // surfaced to the model each step
      const url = page.url();
      let title = ''; try { title = await page.title(); } catch {}
      const shot = `step-${String(n).padStart(2, '0')}.png`;
      try { await page.screenshot({ path: path.join(o.out, shot) }); } catch {}

      const prompt = buildPrompt(o, { n, url, title, els, newErrors, lastResult });
      const resp = await askMimo(o, prompt);
      totalCost += resp.cost || 0;
      if (!resp.ok) { // timeout / spawn error / unparseable — do NOT pretend the run completed
        modelError = resp.error || 'model unavailable';
        steps.push({ n, url, title, screenshot: shot, observation: `model call failed: ${modelError}`, bugs: [], action: { type: 'abort' }, result: modelError, newErrors });
        console.log(`step ${n}: model call failed (${modelError}) — stopping`);
        break;
      }
      const decision = extractJson(resp.text) || { observation: 'model returned no parseable JSON', bugs: [], action: { type: 'done' }, done: true };
      const stepBugs = Array.isArray(decision.bugs) ? decision.bugs : [];
      for (const b of stepBugs) if (b && b.desc) allBugs.push({ severity: (b.severity || 'low').toLowerCase(), desc: String(b.desc).slice(0, 300), step: n });

      const action = decision.action || { type: 'done' };
      const stepRec = { n, url, title, screenshot: shot, observation: decision.observation || '', bugs: stepBugs, action, newErrors };
      console.log(`step ${n}: ${action.type}${action.index != null ? ' #' + action.index : ''} — ${(decision.observation || '').slice(0, 80)}${stepBugs.length ? ' [' + stepBugs.length + ' bug]' : ''}`);

      if (decision.done === true || (action.type || '').toLowerCase() === 'done') { stepRec.result = 'done'; steps.push(stepRec); break; }
      lastResult = await executeAction(page, action, o.sample);
      stepRec.result = lastResult;
      steps.push(stepRec);
      await page.waitForTimeout(900);
    }

    // De-dupe bugs by description.
    const seen = new Set();
    for (const b of allBugs) { const k = b.desc.toLowerCase().slice(0, 80); if (!seen.has(k)) { seen.add(k); bugs.push(b); } }

    // Deterministic verdict (failed requests count too), refined by one final Mimo call.
    verdict = bugs.some((b) => rank[b.severity] >= 2) ? 'fail' : (bugs.length || pageErrors.length || consoleErrors.length || failedRequests.length) ? 'issues' : 'pass';
    summary = `${bugs.length} bug(s); ${consoleErrors.length} console error(s); ${failedRequests.length} failed request(s) across ${steps.length} step(s).`;
    if (!modelError) {
      const fp = `You QA-tested a web app. GOAL: ${o.goal}\nBUGS: ${JSON.stringify(bugs)}\nCONSOLE_ERRORS: ${JSON.stringify(consoleErrors.slice(0, 10))}\nFAILED_REQUESTS: ${JSON.stringify(failedRequests.slice(0, 10))}\nReply ONLY JSON: {"verdict":"pass|issues|fail","summary":"2-3 sentence verdict for a developer"}`;
      const resp = await askMimo(o, fp); totalCost += resp.cost || 0;
      const j = extractJson(resp.text);
      if (j && j.verdict) { verdict = j.verdict; summary = j.summary || summary; }
    } else { // an incomplete run must not read as a clean pass
      summary = `Run ended early (${modelError}). ${summary}`;
      if (verdict === 'pass') verdict = 'issues';
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const report = {
    goal: o.goal, base: o.base, steps, bugs,
    consoleErrors, pageErrors, failedRequests,
    cost: totalCost ? totalCost.toFixed(4) : '0', verdict, summary, model: o.model,
    incomplete: !!modelError,
  };
  fs.writeFileSync(path.join(o.out, 'report.json'), JSON.stringify(report, null, 2));
  writeHtml(o.out, report);
  console.log(`\nVERDICT ${verdict} • ${bugs.length} bugs • $${report.cost}`);
  process.exit(0);
})().catch((e) => { console.error('qa-drive fatal:', e.message); process.exit(1); });

function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function writeHtml(out, r) {
  const h = [];
  h.push('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sentinel QA</title>');
  h.push('<style>body{font:15px/1.55 system-ui;margin:24px;max-width:1000px;background:#0d0d0f;color:#e8e8ea}img{max-width:100%;border:1px solid #2a2a30;border-radius:8px}h1,h2{border-bottom:1px solid #2a2a30;padding-bottom:6px}.v{display:inline-block;padding:3px 10px;border-radius:6px;font-weight:600}.pass{background:#0f3d1f;color:#7ee29a}.issues{background:#3d320f;color:#e2cb7e}.fail{background:#3d1414;color:#e28a8a}.sev{font-weight:700}.critical,.high{color:#ff8a8a}.medium{color:#ffd27e}.low{color:#9aa}.step{border:1px solid #2a2a30;border-radius:10px;padding:12px 16px;margin:14px 0}.muted{color:#9aa}code{background:#1a1a1f;padding:1px 5px;border-radius:4px}</style>');
  h.push(`<h1>📋 Sentinel QA <span class="v ${esc(r.verdict)}">${esc(r.verdict)}</span></h1>`);
  h.push(`<p class="muted">${esc(r.base)} • model ${esc(r.model)} • $${esc(r.cost)} • ${r.steps.length} steps</p>`);
  h.push(`<p><b>Goal:</b> ${esc(r.goal)}</p><p><b>Summary:</b> ${esc(r.summary)}</p>`);
  h.push('<h2>Bugs (' + r.bugs.length + ')</h2>');
  if (r.bugs.length) { h.push('<ul>'); for (const b of r.bugs) h.push(`<li><span class="sev ${esc(b.severity)}">[${esc(b.severity)}]</span> ${esc(b.desc)} <span class="muted">(step ${b.step})</span></li>`); h.push('</ul>'); }
  else h.push('<p class="muted">None found.</p>');
  if (r.consoleErrors.length) { h.push('<h2>Console errors (' + r.consoleErrors.length + ')</h2><ul>'); for (const e of r.consoleErrors.slice(0, 30)) h.push('<li><code>' + esc(e) + '</code></li>'); h.push('</ul>'); }
  if (r.failedRequests.length) { h.push('<h2>Failed requests (' + r.failedRequests.length + ')</h2><ul>'); for (const e of r.failedRequests.slice(0, 30)) h.push('<li><code>' + esc(e) + '</code></li>'); h.push('</ul>'); }
  h.push('<h2>Action trace</h2>');
  for (const s of r.steps) {
    h.push('<div class="step">');
    h.push(`<b>Step ${s.n}</b> — <code>${esc(s.action && s.action.type)}${s.action && s.action.index != null ? ' #' + s.action.index : ''}</code> <span class="muted">${esc(s.url)}</span>`);
    h.push(`<p>${esc(s.observation)}</p>`);
    if (s.result) h.push(`<p class="muted">→ ${esc(s.result)}</p>`);
    if (s.bugs && s.bugs.length) for (const b of s.bugs) h.push(`<p><span class="sev ${esc((b.severity || 'low').toLowerCase())}">[${esc(b.severity)}]</span> ${esc(b.desc)}</p>`);
    h.push(`<img loading="lazy" src="${esc(s.screenshot)}">`);
    h.push('</div>');
  }
  fs.writeFileSync(path.join(out, 'report.html'), h.join('\n'));
}
