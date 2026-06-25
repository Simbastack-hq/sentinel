#!/usr/bin/env node
/* mimo-vision.js — send an image + prompt to Xiaomi's multimodal model (mimo-v2-omni) and print the
 * answer. Used by the UI/UX review pass (Mimo can SEE the screenshot, unlike text-only mimo-v2.5-pro).
 * Usage: mimo-vision.js <imagePath> "<prompt>"   (prompt may also arrive on stdin)
 * Key: $XIAOMI_API_KEY or ~/.pi/agent/auth.json .xiaomi.key. Prints answer to stdout; usage JSON to stderr.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// Provider-agnostic: VISION_* are the generic knobs (Xiaomi/Mimo default, or OpenRouter, etc.);
// XIAOMI_*/MIMO_* remain as back-compat aliases.
const DEFAULT_BASE = 'https://api.xiaomimimo.com/v1';
const BASE = process.env.VISION_BASE_URL || process.env.XIAOMI_BASE_URL || DEFAULT_BASE;
const IS_DEFAULT_BASE = BASE === DEFAULT_BASE;
const MODEL = process.env.VISION_MODEL || process.env.MIMO_VISION_MODEL || (IS_DEFAULT_BASE ? 'mimo-v2-omni' : '');
const TIMEOUT = (parseInt(process.env.MIMO_VISION_TIMEOUT || '150', 10)) * 1000;
const MAXTOK = parseInt(process.env.MIMO_VISION_MAXTOK || '2200', 10); // omni is a reasoning model — needs room
const EXTRA_HEADERS = {}; // optional OpenRouter attribution headers (harmless elsewhere)
if (process.env.VISION_HTTP_REFERER) EXTRA_HEADERS['HTTP-Referer'] = process.env.VISION_HTTP_REFERER;
if (process.env.VISION_TITLE) EXTRA_HEADERS['X-Title'] = process.env.VISION_TITLE;

function getKey() {
  if (process.env.VISION_API_KEY) return process.env.VISION_API_KEY;
  if (!IS_DEFAULT_BASE) return ''; // never send Xiaomi creds to a non-Xiaomi endpoint — require VISION_API_KEY there
  if (process.env.XIAOMI_API_KEY) return process.env.XIAOMI_API_KEY;
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.pi/agent/auth.json'), 'utf8')).xiaomi.key; }
  catch { return ''; }
}

(async () => {
  const [imgPath, ...rest] = process.argv.slice(2);
  let prompt = rest.join(' ');
  if (!prompt) { try { prompt = fs.readFileSync(0, 'utf8').trim(); } catch {} }
  if (!imgPath || !prompt) { console.error('usage: mimo-vision.js <image> "<prompt>"'); process.exit(2); }
  if (!fs.existsSync(imgPath)) { console.error('mimo-vision: image not found: ' + imgPath); process.exit(2); }
  const key = getKey();
  if (!key) { console.error('mimo-vision: no vision API key (set VISION_API_KEY for a custom VISION_BASE_URL, else XIAOMI_API_KEY or ~/.pi/agent/auth.json)'); process.exit(3); }
  if (!MODEL) { console.error('mimo-vision: set VISION_MODEL when using a non-default VISION_BASE_URL'); process.exit(3); }

  const mime = imgPath.toLowerCase().endsWith('.jpg') || imgPath.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
  const b64 = fs.readFileSync(imgPath).toString('base64');
  const body = {
    model: MODEL, max_tokens: MAXTOK,
    messages: [{ role: 'user', content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
    ] }],
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  let resp;
  try {
    resp = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...EXTRA_HEADERS },
      body: JSON.stringify(body), signal: ctrl.signal,
    });
  } catch (e) { clearTimeout(timer); console.error('mimo-vision request failed:', e.message); process.exit(1); }
  clearTimeout(timer);
  const d = await resp.json().catch(() => ({}));
  if (d.usage) process.stderr.write('USAGE=' + JSON.stringify(d.usage) + '\n');
  const ch = (d.choices || [{}])[0] || {};
  const content = ch.message && ch.message.content;
  if (content && content.trim()) { process.stdout.write(content.trim() + '\n'); process.exit(0); }
  console.error('mimo-vision: empty content (finish=' + (ch.finish_reason || '?') + ') ' + JSON.stringify(d).slice(0, 300));
  process.exit(1);
})();
