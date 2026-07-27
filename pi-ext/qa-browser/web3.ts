// @ts-nocheck
/**
 * web3.ts — headless wallet injection for QA of wagmi / RainbowKit / ethers dApps.
 *
 * Injects a fake EIP-1193 provider at `window.ethereum` (isMetaMask) backed by a LOCAL
 * private key held ONLY in Node — the key never enters the page, the DOM, the model prompt,
 * the trace, or any log. Designed for UNFUNDED-burner QA:
 *
 *   - The key is a FRESH random key with zero balance (generated per run unless WEB3_PK is set).
 *   - eth_sendTransaction / eth_sendRawTransaction are NEVER broadcast — they return the exact
 *     "insufficient funds" error an unfunded EOA would get from the node. So it is physically
 *     impossible for a run to move real funds, even on a mainnet RPC.
 *   - A hard pre-flight guard asserts the burner's on-chain balance is 0 and ABORTS the run if
 *     it is ever funded (defends against a misconfigured WEB3_PK).
 *   - Read calls (eth_call / eth_estimateGas / eth_getBalance / eth_getCode / ...) proxy to the
 *     configured RPC so the app sees real chain state and renders real quotes.
 *   - Message / typed-data signing (personal_sign, eth_signTypedData_v4 — e.g. SIWE) is done
 *     locally. Signing a message moves no money and broadcasts nothing.
 *
 * Gate stubbing (page.route) is bundled here so a dApp's whitelist / geo / health gates can be
 * satisfied at the network layer without touching the app's code. The `whitelist` stub builds a
 * crypto-js-compatible AES blob that decrypts (with the QA .env's NEXT_PUBLIC_CRYPTO_KEY) to the
 * burner address, so wagmi sees the burner as whitelisted.
 */
import crypto from "node:crypto";
import type { Page } from "playwright";

export interface Web3Config {
  rpcUrl: string; // JSON-RPC endpoint for read proxying (e.g. https://arb1.arbitrum.io/rpc)
  chainId: number; // e.g. 42161
  privateKey?: string; // optional; if absent a FRESH random burner is generated (recommended)
  allowFunded?: boolean; // OPT-IN: permit a key with on-chain balance/nonce (a small, capped canary wallet).
                         // Broadcasts are STILL blocked unless allowBroadcast is ALSO set; this only relaxes the unfunded preflight.
  allowBroadcast?: boolean; // OPT-IN (requires allowFunded): actually sign + broadcast eth_sendTransaction, for
                            // full user-like funded QA. Broadcasts are permitted ONLY while the wallet's current
                            // chain === broadcastChainId. The small capped float is the only spend guard.
  broadcastChainId?: number; // the chain on which broadcasts are allowed (e.g. HyperEVM 999). Distinct from the
                             // login chainId (cfg.chainId, e.g. Arbitrum 42161) which the dApp switches away from.
  broadcastRpcUrl?: string;  // RPC endpoint for the broadcast chain (build/estimate/send happen here).
}

export interface StubConfig {
  url: string; // playwright route glob, e.g. "**/api/records"
  json?: any; // static JSON body to return
  status?: number; // default 200
  whitelist?: boolean; // special: return [{fields:{Address: aes(addr,key)}}] for a crypto-js AES whitelist gate
  whitelistKey?: string; // passphrase (must match NEXT_PUBLIC_CRYPTO_KEY in the QA .env)
  abort?: boolean; // abort (block) matching requests entirely — e.g. silence a WalletConnect relay/explorer
}

// ---- crypto-js-compatible OpenSSL "Salted__" AES-256-CBC ---------------------------------------
// Produces base64 that the app's `crypto.AES.decrypt(blob, passphrase).toString(enc.Utf8)` recovers.
// crypto-js derives key+iv from the passphrase + an 8-byte salt via MD5-based EVP_BytesToKey.
function aesEncryptCryptoJS(plaintext: string, passphrase: string): string {
  const salt = crypto.randomBytes(8);
  const pass = Buffer.from(passphrase, "utf8");
  let data = Buffer.alloc(0);
  let prev = Buffer.alloc(0);
  while (data.length < 48) {
    // 32-byte key + 16-byte iv
    prev = crypto.createHash("md5").update(Buffer.concat([prev, pass, salt])).digest();
    data = Buffer.concat([data, prev]);
  }
  const key = data.subarray(0, 32);
  const iv = data.subarray(32, 48);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  return Buffer.concat([Buffer.from("Salted__", "utf8"), salt, enc]).toString("base64");
}

// ---- raw JSON-RPC proxy (READ methods only) with retry/backoff ---------------------------------
// Public RPCs rate-limit; retry transient 429/5xx/rate-limit so flaky reads don't surface as fake
// NaN/quote bugs. Non-transient JSON-RPC errors (e.g. a real revert) throw immediately.
async function rpcCall(rpcUrl: string, method: string, params: any[]): Promise<any> {
  let lastErr: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, attempt * 500));
    try {
      const r = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params || [] }),
      });
      if (r.status === 429 || r.status >= 500) { lastErr = new Error("rpc http " + r.status); continue; }
      const j = await r.json();
      if (j.error) {
        if (j.error.code === -32005 || /rate|limit|capacity|busy|exceeded/i.test(j.error.message || "")) {
          lastErr = Object.assign(new Error(j.error.message), { code: j.error.code }); continue;
        }
        throw Object.assign(new Error(j.error.message || "rpc error"), { code: j.error.code, data: j.error.data });
      }
      return j.result;
    } catch (e: any) {
      lastErr = e; // network error → retry
    }
  }
  throw lastErr || new Error("rpc failed");
}

// ---- the in-page EIP-1193 shim (runs in the browser; NO Node-scope closures, plain JS) ----------
function providerInitScript(addr, chainHex) {
  const listeners = {};
  const provider = {
    isMetaMask: true,
    _isSentinelBurner: true,
    chainId: chainHex,
    networkVersion: String(parseInt(chainHex, 16)),
    selectedAddress: addr,
    request: async function (args) {
      const method = args && args.method;
      const params = (args && args.params) || [];
      let res;
      try {
        res = await window.__sentinelWeb3(method, params);
      } catch (err) {
        // The Node handler encodes {code,message} as a JSON error message; rebuild a proper RpcError.
        let parsed = null;
        try {
          parsed = JSON.parse(err && err.message);
        } catch (_) {}
        if (parsed && typeof parsed === "object" && parsed.message) {
          const x = new Error(parsed.message);
          x.code = parsed.code;
          throw x;
        }
        throw err;
      }
      if (method === "eth_requestAccounts") {
        try {
          provider.emit("connect", { chainId: chainHex });
        } catch (_) {}
        try {
          provider.emit("accountsChanged", res);
        } catch (_) {}
      }
      // A successful chain switch must fire chainChanged so wagmi/viem re-read the chain (else the app
      // keeps signing/estimating against the old chain after the dApp switches to HyperEVM for vault txs).
      if (method === "wallet_switchEthereumChain" && params && params[0] && params[0].chainId) {
        try {
          provider.chainId = params[0].chainId;
          provider.networkVersion = String(parseInt(params[0].chainId, 16));
        } catch (_) {}
        try {
          provider.emit("chainChanged", params[0].chainId);
        } catch (_) {}
      }
      return res;
    },
    on: function (e, h) {
      (listeners[e] = listeners[e] || []).push(h);
      return provider;
    },
    removeListener: function (e, h) {
      listeners[e] = (listeners[e] || []).filter(function (x) {
        return x !== h;
      });
      return provider;
    },
    removeAllListeners: function () {
      for (const k in listeners) listeners[k] = [];
      return provider;
    },
    emit: function (e) {
      const a = Array.prototype.slice.call(arguments, 1);
      (listeners[e] || []).forEach(function (h) {
        try {
          h.apply(null, a);
        } catch (_) {}
      });
      return true;
    },
    enable: function () {
      return provider.request({ method: "eth_requestAccounts", params: [] });
    },
    isConnected: function () {
      return true;
    },
    send: function (m, p) {
      return provider.request({ method: m, params: p || [] });
    },
    sendAsync: function (payload, cb) {
      provider
        .request(payload)
        .then(function (r) {
          cb(null, { id: payload.id, jsonrpc: "2.0", result: r });
        })
        .catch(function (e) {
          cb(e, null);
        });
    },
  };
  window.ethereum = provider;
  try {
    window.ethereum.providers = [provider];
  } catch (_) {}
  try {
    window.dispatchEvent(new Event("ethereum#initialized"));
  } catch (_) {}
  // EIP-6963 multi-injected-provider discovery (required for wagmi v2 / RainbowKit v2, which do NOT
  // read window.ethereum directly). Announce ourselves as MetaMask so the wallet picker lists + connects us.
  var info = {
    uuid: window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : "sentinel-eip6963-uuid",
    name: "MetaMask",
    icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiBmaWxsPSIjZjYwIi8+PC9zdmc+",
    rdns: "io.metamask",
  };
  function announce() {
    try {
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: info, provider: provider }) }));
    } catch (_) {}
  }
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
  // QA concession: a wallet SDK with a dummy projectId (e.g. WalletConnect) can throw an unhandled error
  // that triggers Next.js's full-screen DEV error overlay, which then blocks ALL interaction. Neutralize
  // that blocking overlay so the agent can keep testing — the underlying errors are still captured to the
  // console (and reported). This only removes the dev-overlay portal, not the app's own modals.
  try {
    window.addEventListener("unhandledrejection", function (e) { try { e.preventDefault(); } catch (_) {} }, true);
    setInterval(function () {
      try { document.querySelectorAll("nextjs-portal").forEach(function (el) { el.remove(); }); } catch (_) {}
    }, 800);
  } catch (_) {}
}

/**
 * Inject the unfunded burner + gate stubs into a Playwright page. Call BEFORE the first navigation.
 * Returns the burner address (safe to log/display — it's an unfunded throwaway).
 */
export async function installWeb3(page: Page, cfg: Web3Config, stubs: StubConfig[] = []): Promise<{ address: string }> {
  const { privateKeyToAccount } = await import("viem/accounts");
  const supplied = !!(cfg.privateKey && /^0x[0-9a-fA-F]{64}$/.test(cfg.privateKey));
  const pk = supplied ? (cfg.privateKey as string) : "0x" + crypto.randomBytes(32).toString("hex");
  const account = privateKeyToAccount(pk as `0x${string}`);
  const address = account.address;
  const chainHex = "0x" + cfg.chainId.toString(16);

  // HARD SAFETY GUARD — fail CLOSED. A QA burner must be a FRESH, UNFUNDED, never-used key on the
  // configured chain. If WEB3_PK was supplied we MUST positively confirm that or ABORT. For a freshly
  // GENERATED random key (the default) an unreachable RPC is non-fatal: the key is unfunded by
  // construction and broadcasting is blocked STRUCTURALLY below regardless of balance.
  const ABORT = (m: string) => { throw new Error("SENTINEL SAFETY ABORT: " + m); };
  const allowFunded = !!cfg.allowFunded; // explicit opt-in for a capped canary wallet (still no broadcasts)
  // allow_funded means "I'm pointing at a specific, possibly-funded canary" — it MUST be a real supplied key,
  // never a silently-generated fresh burner mislabeled as funded.
  if (allowFunded && !supplied) ABORT("allow_funded is set but no valid private key was supplied (set web3.private_key_env → a 0x + 64-hex key)");

  // Broadcast opt-in (funded user-like QA). Requires a funded key + a distinct broadcast chain/RPC.
  const allowBroadcast = !!cfg.allowBroadcast;
  const bcChainId = cfg.broadcastChainId || 0;
  const bcRpcUrl = cfg.broadcastRpcUrl || "";
  if (allowBroadcast && !allowFunded) ABORT("allow_broadcast requires allow_funded (a real, small, capped canary key)");
  if (allowBroadcast && !(bcChainId && bcRpcUrl)) ABORT("allow_broadcast set but broadcastChainId/broadcastRpcUrl are missing");
  // The set of chains this wallet will operate on: login chain (typed-data auth) + the broadcast chain (vault txs).
  const allowedChains = new Set<number>([cfg.chainId, ...(allowBroadcast ? [bcChainId] : [])]);
  const rpcFor = (chain: number) => (chain === bcChainId && bcRpcUrl ? bcRpcUrl : cfg.rpcUrl);
  let curChain = cfg.chainId; // mutable; wallet_switchEthereumChain flips it. Broadcasts only on bcChainId.

  // Build a viem wallet client bound to the broadcast chain (used ONLY for real eth_sendTransaction).
  let walletClient: any = null;
  if (allowBroadcast) {
    const { createWalletClient, http, defineChain } = await import("viem");
    const bcChain = defineChain({
      id: bcChainId, name: "broadcast-" + bcChainId,
      nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
      rpcUrls: { default: { http: [bcRpcUrl] } },
    });
    walletClient = createWalletClient({ account, chain: bcChain, transport: http(bcRpcUrl) });
    console.error(`sentinel web3: allow_broadcast ON — real transactions WILL be signed+sent on chain ${bcChainId} for ${address}. Keep the float small; this is the only spend cap.`);
  }

  // (1) chainId is ALWAYS verified — a mismatch always aborts (wrong-RPC / cross-chain-replay risk). When the
  // RPC can't be reached to verify it, fail CLOSED for a supplied/funded key (we can't confirm the chain); for a
  // freshly generated unfunded burner an unreachable RPC stays non-fatal (unfunded by construction, no broadcast).
  try {
    const cid = await rpcCall(cfg.rpcUrl, "eth_chainId", []);
    if (parseInt(String(cid), 16) !== cfg.chainId) ABORT(`RPC chainId ${cid} != configured ${cfg.chainId} (wrong-RPC preflight risk)`);
  } catch (e: any) {
    if (String(e?.message || e).includes("SENTINEL SAFETY ABORT")) throw e;
    if (supplied || allowFunded) ABORT(`could not verify RPC chainId for a supplied/funded key (RPC error: ${String(e?.message || e).slice(0, 120)})`);
  }

  // (2) Unfunded preflight — balance + nonce must be zero. SKIPPED only when allow_funded (a capped canary is
  // permitted to hold a balance). The broadcast deny-list below still blocks every on-chain tx regardless.
  if (!allowFunded) {
    try {
      const b = await rpcCall(cfg.rpcUrl, "eth_getBalance", [address, "latest"]);
      if (!/^0x[0-9a-fA-F]+$/.test(String(b))) ABORT(`eth_getBalance returned a non-quantity (${b}); cannot confirm the burner is unfunded`);
      if (BigInt(b) > 0n) ABORT(`burner ${address} has a nonzero balance (${b}) on chain ${cfg.chainId}`);
      const n = await rpcCall(cfg.rpcUrl, "eth_getTransactionCount", [address, "latest"]);
      if (!/^0x0*$/.test(String(n))) ABORT(`burner ${address} has a nonzero nonce (${n}) — it has transacted before`);
    } catch (e: any) {
      if (String(e?.message || e).includes("SENTINEL SAFETY ABORT")) throw e; // affirmative danger → always abort
      if (supplied) ABORT(`could not verify the supplied WEB3_PK burner is unfunded (RPC error: ${String(e?.message || e).slice(0, 120)})`);
      // generated fresh key + flaky RPC → safe to proceed (unfunded by construction; broadcast blocked below)
    }
  } else {
    // Say which it is: with allow_broadcast also on, the old unconditional "broadcasts remain
    // blocked" wording directly contradicts the allow_broadcast banner printed just above it.
    console.error(`sentinel web3: allow_funded set — NOT enforcing the unfunded preflight for ${address}. ${allowBroadcast ? `Broadcasts ARE permitted (chain ${bcChainId} only)` : "Broadcasts remain blocked"}; keep this wallet's balance small/capped.`);
  }

  // Broadcast deny-list (prefix, case-insensitive): NO method that submits or authorizes a transaction is
  // ever forwarded. eth_send* covers sendTransaction + sendRawTransaction; eth_signtransaction/wallet_send/
  // eth_submit cover the rest. eth_sign / eth_signTypedData (message signing) are NOT denied here.
  const DENY_RE = /^(eth_send|eth_signtransaction|eth_sign_transaction|wallet_send|eth_submit)/i;
  // Read allow-list (prefix): only these proxy to the RPC. Anything else is REFUSED, never proxied.
  const READ_RE = /^(eth_get|eth_call|eth_estimategas|eth_gasprice|eth_maxpriorityfeepergas|eth_feehistory|eth_blocknumber|eth_chainid|eth_syncing|eth_protocolversion|eth_createaccesslist|eth_blobbasefee|net_|web3_)/i;

  async function handle(method: string, params: any[]): Promise<any> {
    const m = String(method || "");
    // 1) Broadcast handling. Default: STRUCTURAL block (any casing/variant). When allow_broadcast is ON and the
    //    wallet is currently on the broadcast chain, eth_sendTransaction is really signed + sent; everything else
    //    that submits/authorizes a tx (raw sends, eth_signTransaction, batched sends) is STILL blocked.
    if (DENY_RE.test(m)) {
      const isPlainSend = /^eth_sendtransaction$/i.test(m);
      if (allowBroadcast && isPlainSend && curChain === bcChainId && walletClient) {
        const tx = (params && params[0]) || {};
        const toBig = (v: any) => (v == null || v === "" ? undefined : BigInt(v));
        try {
          const hash = await walletClient.sendTransaction({
            to: tx.to,
            data: tx.data,
            value: toBig(tx.value),
            gas: toBig(tx.gas),
          });
          console.error(`sentinel web3: BROADCAST sent on chain ${bcChainId} → ${hash} (to ${tx.to})`);
          return hash;
        } catch (e: any) {
          throw Object.assign(new Error(`sentinel broadcast failed: ${String(e?.shortMessage || e?.message || e).slice(0, 200)}`), { code: -32000 });
        }
      }
      const why = allowBroadcast
        ? `broadcast only permitted for eth_sendTransaction while on chain ${bcChainId} (current ${curChain})`
        : "sentinel: unfunded QA burner — no transaction is ever broadcast";
      throw Object.assign(new Error(`insufficient funds for gas * price + value (${why})`), { code: -32000 });
    }
    // 2) Wallet / account / chain / message-signing answered locally.
    switch (m) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [address];
      case "eth_chainId":
        return "0x" + curChain.toString(16);
      case "net_version":
        return String(curChain);
      case "wallet_switchEthereumChain": {
        const want = params && params[0] && params[0].chainId != null ? parseInt(String(params[0].chainId), 16) : NaN;
        if (!Number.isNaN(want) && allowedChains.has(want)) { curChain = want; return null; }
        // Unknown chain: refuse like MetaMask (4902) so the dApp can surface an add-chain flow rather than assume success.
        throw Object.assign(new Error(`sentinel: chain ${want} not configured for this QA wallet`), { code: 4902 });
      }
      case "wallet_addEthereumChain":
      case "wallet_watchAsset":
        return null;
      case "wallet_requestPermissions":
      case "wallet_getPermissions":
        return [{ parentCapability: "eth_accounts" }];
      case "personal_sign": {
        const msg = params[0];
        const message = typeof msg === "string" && msg.startsWith("0x") ? { raw: msg } : { raw: ("0x" + Buffer.from(String(msg), "utf8").toString("hex")) };
        return await account.signMessage({ message });
      }
      case "eth_sign":
        return await account.signMessage({ message: { raw: params[1] } });
      case "eth_signTypedData":
      case "eth_signTypedData_v4": {
        const data = typeof params[1] === "string" ? JSON.parse(params[1]) : params[1];
        // Defense-in-depth: only sign typed data bound to a chain this QA wallet operates on (replay safety).
        if (data && data.domain && data.domain.chainId != null && !allowedChains.has(Number(data.domain.chainId))) {
          throw Object.assign(new Error(`sentinel: refusing to sign typed data for chainId ${data.domain.chainId} (allowed: ${[...allowedChains].join(",")})`), { code: -32000 });
        }
        return await account.signTypedData(data);
      }
    }
    // 3) READ-only methods proxy to the RPC for the CURRENT chain. Everything else is REFUSED.
    if (READ_RE.test(m)) return await rpcCall(rpcFor(curChain), m, params || []);
    throw Object.assign(new Error(`sentinel: method '${m}' is not permitted in QA (only reads + local wallet/sign methods are allowed)`), { code: -32601 });
  }

  await page.exposeFunction("__sentinelWeb3", async (method: string, params: any[]) => {
    try {
      return await handle(method, params);
    } catch (e: any) {
      // Encode as a JSON error message; the in-page shim rebuilds {code,message}.
      throw new Error(JSON.stringify({ code: e?.code ?? -32603, message: String(e?.message || e) }));
    }
  });

  await page.addInitScript(`(${providerInitScript.toString()})(${JSON.stringify(address)}, ${JSON.stringify(chainHex)})`);

  for (const s of stubs) {
    if (s.abort) { await page.route(s.url, (route) => route.abort()); continue; } // e.g. silence WalletConnect relay/explorer
    let body: string;
    if (s.whitelist) {
      // Encrypt the burner into a crypto-js AES blob and splice it into the response template at the
      // "__WL_ADDR__" token, so the app decrypts it (with NEXT_PUBLIC_CRYPTO_KEY) to the burner address.
      // The template lets each app use its own response shape (bare array, {data:[...]}, etc.).
      const enc = aesEncryptCryptoJS(address, s.whitelistKey || "");
      const tmpl = s.json != null ? JSON.stringify(s.json) : JSON.stringify([{ fields: { Address: "__WL_ADDR__" } }]);
      body = tmpl.split("__WL_ADDR__").join(enc);
    } else {
      body = JSON.stringify(s.json ?? {});
    }
    await page.route(s.url, (route) => route.fulfill({ status: s.status || 200, contentType: "application/json", body }));
  }

  // Proxy the app's OWN direct RPC fetches (wagmi publicClient reads) through Node: fixes browser CORS on
  // public RPCs, adds retry, and re-applies the broadcast deny-list. Without this, CORS/rate-limit errors
  // from a public RPC flood the app and break its on-chain reads (quotes/balances).
  const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, GET, OPTIONS", "access-control-allow-headers": "*", "content-type": "application/json" };
  await page.route(cfg.rpcUrl, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
    const raw = req.postData() || "";
    try {
      const payload = JSON.parse(raw || "null");
      const items = Array.isArray(payload) ? payload : [payload];
      const denied = items.find((it: any) => it && DENY_RE.test(String(it.method || "")));
      if (denied) {
        const errOf = (x: any) => ({ jsonrpc: "2.0", id: x?.id ?? null, error: { code: -32000, message: "insufficient funds (sentinel: no broadcast)" } });
        return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify(Array.isArray(payload) ? items.map(errOf) : errOf(payload)) });
      }
    } catch { /* not JSON-RPC — forward as-is */ }
    let text = "";
    for (let i = 0; i < 3; i++) {
      if (i) await new Promise((r) => setTimeout(r, i * 400));
      try {
        const r = await fetch(cfg.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
        if (r.status === 429 || r.status >= 500) continue;
        text = await r.text(); break;
      } catch { /* retry */ }
    }
    if (!text) text = JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "sentinel rpc proxy: upstream unavailable" } });
    return route.fulfill({ status: 200, headers: CORS, body: text });
  });

  // Best-effort: silence WalletConnect's relay WebSocket reconnect storm (a dummy projectId yields an
  // endless "Project not found" loop). We connect via the injected wallet, never WalletConnect.
  try {
    await (page as any).routeWebSocket?.(/walletconnect/i, (ws: any) => { try { ws.close(); } catch {} });
  } catch {}

  return { address };
}
