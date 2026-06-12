#!/usr/bin/env node
/* recon.js <repoPath> — emit a compact STRUCTURAL DIGEST of a repo (frontend routes, backend API
 * modules/endpoints, services, data entities) so a model can derive the critical business test flows.
 * Best-effort across common stacks (Next app/pages router, Express/Fastify routes dir, Prisma/Drizzle/SQL).
 * Prints a short human/LLM-readable digest to stdout. Designed to be fast (grep/find, no model). */
const cp = require('child_process');
const repo = process.argv[2];
if (!repo) { console.error('usage: recon.js <repo>'); process.exit(2); }
const sh = (cmd) => { try { return cp.execSync(cmd, { cwd: repo, encoding: 'utf8', maxBuffer: 16e6, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };
const uniq = (s, n) => [...new Set(s.split('\n').map((x) => x.trim()).filter(Boolean))].slice(0, n);

// Frontend routes — Next.js app router, else pages router.
let fe = uniq(sh(`find . \\( -path '*/node_modules/*' -o -path '*/.next/*' \\) -prune -o -path '*/app/*' -name 'page.tsx' -print -o -path '*/app/*' -name 'page.jsx' -print -o -path '*/app/*' -name 'page.js' -print 2>/dev/null`), 80)
  .map((f) => (f.replace(/.*\/app/, '').replace(/\/page\.(tsx|jsx|js)$/, '') || '/'))
  .filter((r) => !/\/\(/.test(r) === false ? true : true); // keep groups too; they reveal structure
if (!fe.length) fe = uniq(sh(`find . -path '*/node_modules/*' -prune -o -path '*/pages/*' -name '*.tsx' -print -o -path '*/pages/*' -name '*.jsx' -print 2>/dev/null`), 80).map((f) => f.replace(/.*\/pages/, '').replace(/\.(tsx|jsx)$/, '').replace(/\/index$/, '/'));
fe = [...new Set(fe)].slice(0, 60);

// Backend API — files inside any routes/ dir, plus explicit route registrations.
const routeDirs = uniq(sh(`find . -path '*/node_modules/*' -prune -o -type d -name routes -print 2>/dev/null`), 10);
let apiModules = [];
for (const d of routeDirs) apiModules.push(...uniq(sh(`ls '${d}' 2>/dev/null`), 120).map((f) => f.replace(/\.(ts|js)$/, '')));
apiModules = [...new Set(apiModules)].filter((x) => x && !/\.(map|d)$/.test(x)).slice(0, 80);
const apiRoutes = uniq(sh(`grep -rhoE "(router|app|fastify|route)\\.(get|post|put|patch|delete)\\(['\\"][^'\\" ]+" . --include=*.ts --include=*.js 2>/dev/null | grep -v node_modules | sed -E "s/.*(get|post|put|patch|delete)\\(['\\"]/\\U\\1\\E /"`), 60);

// Services + jobs/workers (reveal background business logic).
const svcDirs = uniq(sh(`find . -path '*/node_modules/*' -prune -o -type d \\( -name services -o -name workers -o -name jobs -o -name queues \\) -print 2>/dev/null`), 12);
let services = [];
for (const d of svcDirs) services.push(...uniq(sh(`ls '${d}' 2>/dev/null`), 80).map((f) => f.replace(/\.(ts|js)$/, '')));
services = [...new Set(services)].filter((x) => x && !/\.(map|d)$/.test(x)).slice(0, 60);

// Data entities — Prisma models / Drizzle pgTable / SQL CREATE TABLE.
const entities = uniq(sh(`grep -rhoE "^model [A-Za-z][A-Za-z0-9_]*|pgTable\\(['\\"][A-Za-z_][A-Za-z0-9_]*|CREATE TABLE [\\"a-zA-Z_][a-zA-Z0-9_\\"]*" . --include=*.prisma --include=*.ts --include=*.sql 2>/dev/null | grep -v node_modules | sed -E "s/^model |pgTable\\(['\\"]|CREATE TABLE //I; s/['\\"].*//"`), 60);

const out = [];
out.push('FRONTEND ROUTES: ' + (fe.join('  ') || '(none found)'));
out.push('');
out.push('BACKEND API MODULES: ' + (apiModules.join('  ') || '(none found)'));
if (apiRoutes.length) out.push('API ENDPOINTS (sample): ' + apiRoutes.join('  '));
out.push('');
out.push('BACKEND SERVICES/WORKERS: ' + (services.join('  ') || '(none found)'));
out.push('');
out.push('DATA ENTITIES: ' + (entities.join('  ') || '(none found)'));
process.stdout.write(out.join('\n') + '\n');
