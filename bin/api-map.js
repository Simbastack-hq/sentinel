#!/usr/bin/env node
/* api-map.js <repo> [--max N] — emit the app's REAL backend endpoints as `METHOD /full/path`.
 *
 * Why this exists: recon.js used to grep bare handler registrations, which yields sub-paths like
 * `POST /trigger` with the mount prefix stripped off. An agent handed that list cannot call anything,
 * so it guesses (`/api/night-audit/run`, `/execute`, `/start`, …), collects 404s, and concludes the
 * feature does not exist. That is a false CRITICAL and it cost ~30 steps of a real run.
 *
 * So: resolve the mount prefix. `app.route('/api/night-audit', nightAuditRoute)` + the handler
 * `nightAuditRoute.post('/trigger', …)` in the imported module → `POST /api/night-audit/trigger`.
 * Best-effort and dependency-free across Hono/Express/Fastify-style routers plus Next.js route
 * handlers. Anything unresolved is emitted marked, never silently dropped.
 */
const fs = require('fs');
const path = require('path');

const SKIP_DIR = /^(node_modules|\.next|\.git|dist|build|out|coverage|\.turbo|\.vercel|__snapshots__)$/;
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const METHODS = 'get|post|put|patch|delete|options|head|all';

function walk(dir, out = [], depth = 0) {
  if (depth > 12) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) walk(p, out, depth + 1); }
    else if (CODE.test(e.name) && !/\.d\.ts$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) out.push(p);
  }
  return out;
}

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

// './routes/night-audit.js' (TS ESM style) may actually be night-audit.ts — try the real extensions.
function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const stripped = base.replace(/\.(js|mjs|cjs)$/, '');
  const cands = [];
  for (const b of [base, stripped]) {
    cands.push(b, b + '.ts', b + '.tsx', b + '.js', b + '.jsx', b + '.mjs',
      path.join(b, 'index.ts'), path.join(b, 'index.js'));
  }
  for (const c of cands) { try { if (fs.statSync(c).isFile()) return c; } catch {} }
  return null;
}

function collectImports(file, src) {
  const map = {};
  for (const m of src.matchAll(/import\s+(\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"`]([^'"`]+)['"`]/g)) {
    const r = resolveImport(file, m[2]); if (r) map[m[1]] = r;
  }
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) {
    const r = resolveImport(file, m[2]); if (r) map[m[1]] = r;
  }
  return map;
}

// Receivers that expose .get/.set/.delete but are NOT routers. Without this, frontend code like
// `searchParams.delete('showDone')` or `headers.get('x-foo')` lands in the map as a fake endpoint.
const NOT_A_ROUTER = /^(searchParams|params|headers|cookies|url|formData|map|set|cache|store|queryClient|localStorage|sessionStorage|session|state|els|registry|client|redis|db|res|response)$/i;

// Handlers declared in a file: `nightAuditRoute.post('/trigger', …)` → { method, sub }.
// Requires a path-shaped first argument — the other half of the noise filter.
function collectHandlers(src) {
  const out = [];
  const re = new RegExp(`\\b(\\w+)\\s*\\.\\s*(${METHODS})\\(\\s*['"\`](/[^'"\`]*)?['"\`]`, 'g');
  for (const m of src.matchAll(re)) {
    if (NOT_A_ROUTER.test(m[1])) continue;
    if (m[3] === undefined) continue;
    out.push({ method: m[2].toUpperCase(), sub: m[3] });
  }
  return out;
}

// Mounts: `app.route('/api/x', xRoute)` / `app.use('/api/x', xRoute)` / fastify `register(x, {prefix})`.
function collectMounts(src) {
  const out = [];
  for (const m of src.matchAll(/\b\w+\s*\.\s*(?:route|use)\(\s*['"`]([^'"`]+)['"`]\s*,\s*(\w+)\s*[,)]/g)) {
    out.push({ prefix: m[1], ident: m[2] });
  }
  for (const m of src.matchAll(/\bregister\(\s*(\w+)\s*,\s*\{[^}]*prefix\s*:\s*['"`]([^'"`]+)['"`]/g)) {
    out.push({ prefix: m[2], ident: m[1] });
  }
  return out;
}

const joinPath = (prefix, sub) => {
  const p = ('/' + String(prefix || '').replace(/^\/|\/$/g, '')).replace(/\/+$/, '') || '';
  const s = String(sub || '').replace(/^\//, '');
  return (s ? `${p}/${s}` : p || '/').replace(/\/{2,}/g, '/');
};

// Next.js app-router route handlers: app/api/foo/[id]/route.ts + `export async function GET`.
function nextRouteHandlers(files) {
  const out = [];
  for (const f of files) {
    if (!/[\\/]route\.(ts|js|tsx|jsx)$/.test(f)) continue;
    const m = f.match(/[\\/]app[\\/](.*)[\\/]route\.(ts|js|tsx|jsx)$/);
    if (!m) continue;
    const url = '/' + m[1].split(path.sep).filter((seg) => !/^\(.*\)$/.test(seg)).join('/');
    const src = read(f);
    for (const h of src.matchAll(new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+(${METHODS.toUpperCase()})\\b`, 'g'))) {
      out.push(`${h[1]} ${url}`);
    }
  }
  return out;
}

// pages/api/foo.ts → /api/foo (method unknown at this granularity).
function pagesApiRoutes(files) {
  const out = [];
  for (const f of files) {
    const m = f.match(/[\\/]pages[\\/](api[\\/].*)\.(ts|js|tsx|jsx)$/);
    if (!m) continue;
    out.push('ANY /' + m[1].split(path.sep).join('/').replace(/\/index$/, ''));
  }
  return out;
}

function buildMap(repo, max = 200) {
  const files = walk(repo);
  const handlersByFile = new Map();
  const mounts = [];
  for (const f of files) {
    const src = read(f);
    if (!src) continue;
    const h = collectHandlers(src);
    if (h.length) handlersByFile.set(f, h);
    const imports = collectImports(f, src);
    for (const mo of collectMounts(src)) {
      const target = imports[mo.ident];
      if (target) mounts.push({ prefix: mo.prefix, file: target });
    }
  }

  const lines = new Set();
  const mountedFiles = new Set();
  for (const mo of mounts) {
    const hs = handlersByFile.get(mo.file);
    if (!hs) continue;
    mountedFiles.add(mo.file);
    for (const h of hs) lines.add(`${h.method} ${joinPath(mo.prefix, h.sub)}`);
  }

  // Handlers in files nobody mounts: still surface them, flagged, so the agent knows the prefix is
  // unknown rather than assuming the route is absent.
  const orphans = new Set();
  for (const [f, hs] of handlersByFile) {
    // Only server-side route-ish files; a component that calls `.get('/x')` on a fetch wrapper is not an endpoint.
    if (mountedFiles.has(f) || !/[\\/](routes?|controllers?|handlers?|server|api)[\\/]/.test(f)) continue;
    const mod = path.basename(f).replace(CODE, '');
    for (const h of hs) orphans.add(`${h.method} ?/${mod}${h.sub === '/' ? '' : h.sub}`);
  }

  for (const l of nextRouteHandlers(files)) lines.add(l);
  for (const l of pagesApiRoutes(files)) lines.add(l);

  const sorted = [...lines].sort((a, b) => a.split(' ')[1].localeCompare(b.split(' ')[1]) || a.localeCompare(b));
  const orphaned = [...orphans].sort().slice(0, Math.max(0, Math.floor(max / 4)));
  return { endpoints: sorted.slice(0, max), truncated: Math.max(0, sorted.length - max), orphans: orphaned };
}

module.exports = { buildMap };

if (require.main === module) {
  const repo = process.argv[2];
  if (!repo) { console.error('usage: api-map.js <repo> [--max N]'); process.exit(2); }
  const mi = process.argv.indexOf('--max');
  const max = mi > 0 ? parseInt(process.argv[mi + 1], 10) || 200 : 200;
  const { endpoints, truncated, orphans } = buildMap(repo, max);
  if (endpoints.length) process.stdout.write(endpoints.join('\n') + '\n');
  if (truncated) process.stdout.write(`(+${truncated} more endpoints not shown)\n`);
  if (orphans.length) process.stdout.write('\nUNRESOLVED MOUNT PREFIX (module known, prefix not):\n' + orphans.join('\n') + '\n');
}
