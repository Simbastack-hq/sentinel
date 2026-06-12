#!/usr/bin/env node
/* merge-flows.js <qadir> <planPath> — combine per-flow agent reports into one qadir/report.json (so the
 * existing report.md + UI/UX pass work) plus qadir/flows.json. Handles MULTIPLE ATTEMPTS per flow
 * (dirs flow-<i>-a<n>): unions+dedupes bugs across attempts so a bug any attempt finds is reported —
 * the redundancy that turns a non-deterministic agent into reliable coverage. Falls back to flow-<i>. */
const fs = require('fs'); const path = require('path');
const dir = process.argv[2]; const planPath = process.argv[3];
if (!dir) { console.error('usage: merge-flows.js <qadir> <plan.json>'); process.exit(2); }
const plan = (() => { try { return JSON.parse(fs.readFileSync(planPath, 'utf8')); } catch { return {}; } })();
const flowNames = (plan.critical_flows || []).map((f) => f.name);
const rank = { fail: 3, error: 3, issues: 2, unknown: 1, pass: 0 };

const dirs = fs.readdirSync(dir).filter((d) => /^flow-\d+(-a\d+)?$/.test(d));
const byFlow = {};
for (const d of dirs) { const idx = parseInt(d.match(/^flow-(\d+)/)[1], 10); (byFlow[idx] ||= []).push(d); }

const bugs = [], steps = [], con = [], pe = [], fr = [], flows = []; let cost = 0;
const seenBug = new Set();
Object.keys(byFlow).map(Number).sort((a, b) => a - b).forEach((idx) => {
  const name = flowNames[idx] || ('flow ' + idx);
  let verdict = 'pass', bestSummary = '', attempts = 0, flowBugCount = 0;
  for (const d of byFlow[idx].sort()) {
    const rp = path.join(dir, d, 'report.json'); if (!fs.existsSync(rp)) continue;
    let r; try { r = JSON.parse(fs.readFileSync(rp, 'utf8')); } catch { continue; }
    attempts++;
    if ((rank[r.verdict] || 1) > (rank[verdict] || 0)) verdict = r.verdict;
    if ((r.summary || '').length > bestSummary.length) bestSummary = r.summary || '';
    for (const b of (r.bugs || [])) { const k = (name + ':' + (b.desc || '')).toLowerCase().slice(0, 110); if (!seenBug.has(k)) { seenBug.add(k); bugs.push({ ...b, flow: name }); flowBugCount++; } }
    for (const s of (r.steps || [])) steps.push({ ...s, flow: name, screenshot: s.screenshot ? `${d}/${s.screenshot}` : '' });
    con.push(...(r.consoleErrors || [])); pe.push(...(r.pageErrors || [])); fr.push(...(r.failedRequests || []));
    cost += parseFloat(r.cost || 0) || 0;
  }
  flows.push({ name, verdict: attempts ? verdict : 'error', bugs: flowBugCount, attempts, summary: bestSummary || 'no report (agent produced nothing)' });
});

const overall = flows.some((f) => f.verdict === 'fail' || f.verdict === 'error') ? 'fail'
  : flows.some((f) => f.verdict === 'issues' || f.verdict === 'unknown') ? 'issues' : 'pass';
const combined = {
  engine: 'flow', product: plan.product || '', domain: plan.domain || '',
  goal: 'autonomous deep business-flow tests (frontend + backend, multi-attempt)',
  verdict: overall, summary: flows.map((f) => `${f.name} → ${f.verdict}${f.attempts > 1 ? ` (${f.attempts}x)` : ''}`).join('  •  '),
  bugs, steps, consoleErrors: [...new Set(con)], pageErrors: pe, failedRequests: [...new Set(fr)],
  cost: cost ? cost.toFixed(4) : '0', model: 'mimo-v2.5-pro', flows,
};
fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(combined, null, 2));
fs.writeFileSync(path.join(dir, 'flows.json'), JSON.stringify({ product: plan.product, domain: plan.domain, flows }, null, 2));
console.log(`merged ${flows.length} flows (${dirs.length} attempts) → ${overall}, ${bugs.length} unique bugs`);
