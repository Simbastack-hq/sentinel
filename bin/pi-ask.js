#!/usr/bin/env node
// pi-ask.js — run pi non-interactively and print ONLY the model's final text.
// Usage: pi-ask.js [--provider P] [--model M] [--thinking T] [--timeout S] "<prompt>"
// Prints final answer to stdout; prints "COST=<usd>" to stderr. Exit !=0 on failure.
const { spawn } = require('child_process');

function parseArgs(argv) {
  const o = { provider: 'xiaomi', model: 'mimo-v2.5-pro', thinking: 'medium', timeout: 120 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') o.provider = argv[++i];
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--thinking') o.thinking = argv[++i];
    else if (a === '--timeout') o.timeout = parseInt(argv[++i], 10) || 120;
    else rest.push(a);
  }
  o.prompt = rest.join(' ');
  return o;
}

// Parse pi --mode json JSONL stream → { text, cost }.
function parsePiStream(stdout) {
  let text = '', cost = '';
  for (const line of stdout.split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let ev;
    try { ev = JSON.parse(s); } catch { continue; }
    const pick = (msg) => {
      if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) return;
      const t = msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
      if (t) text = t;
      const tot = msg.usage && msg.usage.cost && msg.usage.cost.total;
      if (tot != null) cost = String(tot);
    };
    if (ev.type === 'agent_end' && Array.isArray(ev.messages)) {
      for (const m of ev.messages) pick(m);
    } else if (ev.message) {
      pick(ev.message);
    }
  }
  // Strip ```json / ``` fences if the whole answer is fenced.
  text = text.replace(/^\s*```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  return { text, cost };
}

function askPi(opts) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '-nt', '--no-session', '--mode', 'json',
      '--provider', opts.provider, '--model', opts.model, '--thinking', opts.thinking, opts.prompt];
    const child = spawn('pi', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('pi timeout after ' + opts.timeout + 's')); }, opts.timeout * 1000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', () => { clearTimeout(timer); resolve(parsePiStream(out)); });
  });
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.prompt) { console.error('pi-ask: empty prompt'); process.exit(2); }
  try {
    const { text, cost } = await askPi(opts);
    if (cost) process.stderr.write('COST=' + cost + '\n');
    process.stdout.write(text + '\n');
    process.exit(text ? 0 : 1);
  } catch (e) { console.error('pi-ask error:', e.message); process.exit(1); }
})();

module.exports = { parsePiStream };
