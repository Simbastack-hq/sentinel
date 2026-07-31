#!/usr/bin/env node
/* render-report.js <qadir> — build a single combined report.html from the merged report.json + uiux.json,
 * with flow verdicts, the deduped FE+BE bug list, UI/UX findings, and links to each attempt's screenshot
 * report (each attempt's report.html). Used by the flow engine so the complete report is one openable file. */
const fs = require('fs'); const path = require('path');
const dir = process.argv[2];
if (!dir) { console.error('usage: render-report.js <qadir>'); process.exit(2); }
const j = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return d; } };
const rep = j('report.json', {}); const ui = j('uiux.json', { screens: [] });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const attemptDirs = fs.readdirSync(dir).filter((d) => /^flow-/.test(d) && fs.existsSync(path.join(dir, d, 'report.html'))).sort();

const h = [];
h.push('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sentinel QA — combined</title>');
h.push('<style>body{font:15px/1.55 system-ui;margin:24px;max-width:1040px;background:#0d0d0f;color:#e8e8ea}h1,h2{border-bottom:1px solid #2a2a30;padding-bottom:6px}a{color:#6cf}.v{display:inline-block;padding:3px 10px;border-radius:6px;font-weight:700}.pass{background:#0f3d1f;color:#7ee29a}.issues{background:#3d320f;color:#e2cb7e}.fail{background:#3d1414;color:#e28a8a}.sev{font-weight:700}.critical,.high{color:#ff8a8a}.medium{color:#ffd27e}.low{color:#9aa}.muted{color:#9aa}code{background:#1a1a1f;padding:1px 5px;border-radius:4px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #2a2a30;padding:6px 10px;text-align:left}li{margin:5px 0}</style>');
h.push(`<h1>📋 Sentinel QA — ${esc(rep.product || rep.engine || 'report')} <span class="v ${esc(rep.verdict)}">${esc(rep.verdict)}</span></h1>`);
h.push(`<p class="muted">engine ${esc(rep.engine)} • ${(rep.bugs || []).length} bugs • ${(ui.totalFindings || 0)} UI/UX findings • $${esc(rep.cost)}</p>`);

h.push('<h2>Flows (multi-attempt, unioned)</h2><table><tr><th>Flow</th><th>Verdict</th><th>Attempts</th><th>Bugs</th></tr>');
for (const f of (rep.flows || [])) h.push(`<tr><td>${esc(f.name)}</td><td><span class="v ${esc(f.verdict)}">${esc(f.verdict)}</span></td><td>${f.attempts || 1}</td><td>${f.bugs || 0}</td></tr>`);
h.push('</table>');

h.push('<h2>Bugs — frontend + backend (' + (rep.bugs || []).length + ')</h2>');
if ((rep.reportingGaps || []).length) h.push(`<p class="muted">⚠️ under-reported: ${esc(rep.reportingGaps.join(', '))} described defects without filing them — read those flow summaries.</p>`);
if ((rep.bugs || []).length) { h.push('<ul>'); for (const b of rep.bugs) h.push(`<li><span class="sev ${esc((b.severity || 'low').toLowerCase())}">[${esc(b.severity)}]</span> ${(b.confidence || 'confirmed') !== 'confirmed' ? '<span class="muted">(suspected)</span> ' : ''}${b.flow ? '<span class="muted">(' + esc(b.flow) + ')</span> ' : ''}${esc(b.desc)}${b.evidence ? '<br><span class="muted">evidence: ' + esc(b.evidence) + '</span>' : ''}</li>`); h.push('</ul>'); }
else h.push('<p class="muted">None.</p>');

if ((ui.screens || []).some((s) => (s.findings || []).length)) {
  h.push('<h2>UI/UX review — vision (' + (ui.totalFindings || 0) + ')</h2>');
  for (const s of ui.screens) { if (!(s.findings || []).length) continue; h.push(`<h3>${esc(s.screen)}</h3><p class="muted">${esc(s.summary)}</p><ul>`); for (const f of s.findings) h.push(`<li><span class="sev ${esc((f.severity || 'low').toLowerCase())}">[${esc(f.severity)}/${esc(f.dimension)}]</span> <b>${esc(f.title)}</b> — ${esc(f.detail)} <span class="muted">→ ${esc(f.recommendation)}</span></li>`); h.push('</ul>'); }
}

if (rep.consoleErrors && rep.consoleErrors.length) { h.push('<h2>Console errors (' + rep.consoleErrors.length + ')</h2><ul>'); for (const e of rep.consoleErrors.slice(0, 30)) h.push('<li><code>' + esc(e) + '</code></li>'); h.push('</ul>'); }

h.push('<h2>Per-attempt detail (screenshots + full trace)</h2><ul>');
for (const d of attemptDirs) h.push(`<li><a href="${esc(d)}/report.html">${esc(d)}</a></li>`);
h.push('</ul>');

fs.writeFileSync(path.join(dir, 'report.html'), h.join('\n'));
console.log('wrote combined report.html');
