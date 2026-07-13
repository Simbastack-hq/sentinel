# Sentinel — Design & How It Works

Sentinel is a set of long-running, **specialized** agents that each do one job unattended on a schedule:
code **review**, **docs-sync**, **QA**, and **brain-sync**. It is self-contained — no external project
dependencies, only the CLIs it shells out to (`pi`/Mimo, `claude`, `codex`, `gh`, Playwright).

## 1. The heartbeat

```
scheduler ──(every SCHEDULER_INTERVAL, default 900s)──▶ sentinel tick
                                          │ single-flight lock (var/locks/tick.lock) — ticks never overlap
                                          ▼
                  for each target × enabled agent:
                     cadence_due?  ──no──▶ skip
                         │ yes
                         ▼
                  dispatch_run(target, agent)
                     ├─ make var/runs/<id>/ (meta.json, run.log, artifacts/)
                     ├─ exec agents/<agent>.sh  (RUN_DIR, TARGET_PATH, … in env; RUN_WALL_TIMEOUT cap)
                     │     └─ writes report.md + result.json {verdict, summary, findings, cost, …}
                     ├─ update var/state/<target>__<agent>.json (lastRunSha / lastRunEpoch / verdict)
                     ├─ copy report.md → reports/<target>__<agent>.md
                     └─ ntfy summary
```

- **`lib/common.sh`** is the contract: env loading (caller wins; inline comments stripped; command-substitution blocked), ntfy, `targets.json` accessors, per-(target,agent) state, cadence evaluation, locking, `run_to` (timeout wrapper).
- **`bin/sentinel`** is the CLI + orchestration. `tick` is the heartbeat; `run` forces one agent.
- **`agents/*.sh`** are pure: read env, do work, emit `report.md` + `result.json`.
- **Scheduler is OS-portable.** `sentinel install` picks the backend from `uname -s`: **launchd** on macOS (`launchd/com.sentinel.scheduler.plist`, `StartInterval`), **systemd `--user` timer** on Linux (`systemd/sentinel.{service,timer}`, `OnUnitActiveSec` + `Persistent=true`, with `loginctl enable-linger` so it runs headless), falling back to **cron** when no user-systemd session exists. All three just fire `sentinel tick` on an interval and append to `var/scheduler.log`; `tick` itself, the agents, and `run_to` (which prefers `gtimeout`, else `timeout`) are platform-agnostic.

**Cadence:** `on-commit` compares `git HEAD` to the stored `lastRunSha`; `every:<dur>` compares `now − lastRunEpoch`. State in `var/state/` survives reboots.

**The `advance` field:** `result.json` may carry `advance` (default `1`). `lastRunEpoch` always advances (it's the `every:<dur>` wall-clock timer), but the diff baseline `lastRunSha` advances only when `advance != 0`. An agent emits `advance=0` to **hold** the baseline so a failed window is retried next tick instead of silently skipped. Only brain-sync (a stateful system-of-record) uses it today; review/docs-sync/qa omit it and default to `1`, so their behavior is unchanged.

## 2. review

Computes the diff since the last reviewed SHA (first run: last `REVIEW_LOOKBACK` commits, or the root commit on shallow repos — using `git rev-parse --verify -q` so a missing `HEAD~N` fails cleanly). The diff is embedded in a prompt (truncated to `MAX_REVIEW_DIFF_CHARS`) and sent to a read-only engine — **Mimo** by default (`pi`, fast/cheap), or `codex`/`claude`. The model ends with a `SENTINEL_VERDICT`/`SENTINEL_FINDINGS` footer that's parsed. Bounded by `REVIEW_TIMEOUT` so a stalled call can't jam the scheduler. Never writes; optional PR comment.

## 3. docs-sync

Creates a throwaway `git worktree` at HEAD, runs `claude` scoped to edit only Markdown, then **hard-guards the result**: every changed path must match a doc allow-list (`*.md`, `docs/**`, `README*`, …) and must not match a code/config denylist — one offending file and **all changes are discarded** (`git reset --hard`). If only docs changed it emits a patch (default) or opens a PR; it **never auto-merges** and never touches the real working tree.

## 3b. brain-sync

docs-sync's **cross-repo** sibling: it reads a SOURCE repo's diff but writes into a SEPARATE shared knowledge repo (Simbastack-hq/simbastack-brain). The brain location is **global** config (`BRAIN_PATH`/`BRAIN_GITHUB`/`BRAIN_BASE`) — one sink for the whole fleet — so a target only flips `brain-sync: { enabled, cadence }` on.

Pipeline per run:
1. **Source diff** since `lastRunSha` — the exact baseline mechanism review uses (`cat-file -e` reachability check, `HEAD~REVIEW_LOOKBACK`/root-commit fallbacks), read-only on the source.
2. **Substance gate** (deterministic, pre-LLM): drop lockfile/generated/`dist/` noise; if a window has fewer than `BRAIN_MIN_DIFF_LINES` real changed lines, skip the model call and the PR. Oversized (`> MAX_BRAIN_DIFF_CHARS`) windows fall back to a `--stat` + `git log --oneline` summary so the window is **recorded, never silently dropped**.
3. **Brain-repo lock + worktree:** all brain git ops serialize under `lock_acquire brain-repo` (the tick lock doesn't cover manual `sentinel run`, and every target funnels through one repo). It `worktree prune`s, refuses a mid-rebase/merge base, asserts the clone's `origin` matches `BRAIN_GITHUB`, then branches `sentinel/brain/<run>` from the freshest `origin/$BRAIN_BASE`.
4. **Distill:** `claude` runs with cwd = the brain worktree, `--allowedTools "Edit,Write,Read"` and `--disallowedTools "Bash,WebFetch,WebSearch"` (no egress/exfil), given the source diff + the **current** content of `30-engineering/repos/<slug>.md` and an **append-only dated-bullet** format keyed by the source commit SHA7 — so re-runs converge instead of churning.
5. **Two guards, two axes.** A **path guard** (exact-equality allow-list of one file — not prefix/substring-bypassable) controls *which* file may change; a **content guard** (secret-regex scan of the staged diff) controls *what* may reach the shared repo + PR body. Either violation → `git reset --hard` + `clean -fd`, discard everything, and the patch is wiped on a secret hit.
6. **PR** (gated by `ENABLE_BRAIN_PR`) on simbastack-brain — **never auto-merged**. Push/PR failure deletes any orphaned remote branch.
7. **Baseline discipline:** every failure path emits `advance=0` (hold `lastRunSha`, retry the window); genuine no-ops and real PRs emit `advance=1`. A window of engineering knowledge is never silently lost.

## 4. qa — three engines

Shared boot path (in `agents/qa.sh`): pre-check every port is free (won't boot over / kill a process it didn't start) → boot `start_cmd` on localhost (plain background boot so interactive dev servers like `next dev` survive — a detached session would kill them) → health-check the web port → wait for `aux_ports` (e.g. the API) → run the engine → tear down the **whole process tree** (kill the boot pid + children, reap the ports, and `pkill` by repo path/basename to catch `pnpm --filter`/`tsx watch` stragglers).

**Remote mode (`base_url`):** to QA an already-deployed app (staging/preview/prod), set `base_url` and the boot/teardown path is skipped entirely — Sentinel just confirms the URL answers and drives it. `recon` still runs against the local repo to derive the flows, so flow quality is unchanged; only the *target* moves from a local process to a live origin. `api_base` defaults to `base_url` when unset.

### node-loop (v1)
A deterministic Node loop (`bin/qa-drive.js`) owns control flow; Mimo is a **toolless one-shot brain** (`pi -nt`) called once per step (observe DOM → decide action → Playwright executes). Cheapest, most predictable.

### pi-native (v2)
A pi extension (`pi-ext/qa-browser/`) registers Playwright-backed tools; **Mimo drives them inside pi's own agent loop** with full session memory. Deeper exploration of a single goal.

**Operator hooks + findings routing:** `pre_cmd` runs before the engine and **gates** the run (nonzero exit aborts — the place for a canary-wallet balance-floor check); `post_cmd` always runs after the engine while the app is still reachable (the place for a janitor that closes anything a trading run left open). When `qa.issues.repo` is set, each **new** functional bug is filed as a GitHub issue (`gh`), deduped against a persistent per-target state file (normalized-description hash) so re-found bugs never re-file; `max_per_run` caps tracker floods. Run briefs go to ntfy and, when `NOTIFY_WEBHOOK_URL` is set, to a Discord/Slack-compatible webhook with the filed issue links.

### flow (v3) — autonomous, codebase-aware, deep FE+BE
The headline. Pipeline:

```
recon.js <repo>  →  structural digest (FE routes, API modules, services, DB entities)
       │
       ▼
Mimo (pi-ask) derives critical_flows JSON  →  cached in var/plans/<target>-<sha>.json
       │
       ▼  for each top flow (FLOW_MAX):
   FLOW_ATTEMPTS × [  pi + qa-browser extension, tools:
                        browser_snapshot/click/type/upload/navigate/scroll,
                        api_request (BACKEND assertions), report_bug, finish
                      hard step cap = FLOW_STEPS (action tools refuse past it → must finish)  ]
       │
       ▼
merge-flows.js  →  union + dedupe bugs across attempts, worst verdict per flow, combined report.json
       │
       ▼
uiux-review.js  →  vision pass (mimo-v2-omni) over captured screens
       │
       ▼
render-report.js  →  one combined report.html (flows, FE+BE bugs, UI/UX, links to per-attempt screenshots)
```

**Why each piece:**
- **recon (deterministic) before derive (model):** blind LLM exploration of a monorepo is slow; a fast grep/find digest is what the model actually needs to reason well. When recon can't read the app's router (it understands Next.js today) — or the operator wants curated flows — `plan_file` supplies a hand-authored `critical_flows` JSON that is used verbatim and skips recon+derive entirely.
- **`api_request` tool:** runs `fetch` *inside the page*, reusing the frontend's own captured `Authorization` header — so it asserts real backend state (record fields, status transitions, availability) with the logged-in session. This is how it catches backend-only bugs and UI↔backend mismatches.
- **Multi-attempt union:** a single autonomous run is non-deterministic (one attempt may find 0 bugs, another 5). Running each flow N times and unioning findings turns that variance into reliable coverage.
- **Hard step cap:** a soft "you're over budget" nudge gets ignored; the action tools physically refuse past `FLOW_STEPS`, bounding cost and wall-clock.

## 5. Login & UI/UX vision

- **Login** (optional, `qa.app.login`): before exploration the extension navigates to the login path, fills email/password from env vars (Playwright `fill` + a hydration-safe retype, since React controlled inputs can drop a too-early fill), and submits. Credentials come from `config/sentinel.env` by env-var name — **never** placed in the model prompt, trace, or logs. A same-origin nav guard keeps the agent from wandering off and losing its session.
- **UI/UX review:** `mimo-v2.5-pro` is text-only, so vision uses **`mimo-v2-omni`** via the Xiaomi API directly (a one-shot rubric call with an inline screenshot — no agent loop, so no need to go through pi). `uiux-review.js` sends each key screen with a structured rubric (hierarchy, spacing, contrast/WCAG, typography, consistency, usability/Nielsen, states, density) and parses JSON findings. (omni is a reasoning model — it needs generous `max_tokens` or it cuts off before emitting JSON.)

## 5c. web3 / wallet-dApp QA (unfunded burner)

Some apps gate everything behind a browser wallet (MetaMask/Rabby). A headless agent can't click a wallet extension, so `qa.app.web3` injects a programmatic wallet instead — **without modifying the app's code**.

```
agents/qa.sh                          pi-ext/qa-browser/web3.ts (installWeb3)
  branch+worktree boot              →   page.addInitScript: window.ethereum shim + EIP-6963 announce
  writes gitignored QA .env.local       page.exposeFunction(__sentinelWeb3): key stays in NODE
  WEB3_* env → the extension        →   page.route: stub the gate endpoints (whitelist/geo/health)
                                         ↑ all installed BEFORE the first navigation
```

- **The injected provider** lives at `window.ethereum` (with `isMetaMask`) and, for wagmi v2 / RainbowKit v2, announces itself over **EIP-6963** so the wallet picker lists and connects it. Every JSON-RPC call from the page is delegated to a Node-side handler (`exposeFunction`) backed by a viem account. **The private key never enters the page, DOM, model prompt, trace, report, or logs** — only the address crosses the boundary.
- **No funds can move.** The key is a **fresh random unfunded burner** (per run). Broadcast is blocked **structurally**: a deny-by-prefix rule (`eth_send*`, `eth_signTransaction`, `wallet_send*`, `eth_submit*`) means no transaction is ever signed-and-sent, regardless of casing or funding; only an explicit **read-only allow-list** proxies to the RPC, anything else is refused. A **fail-closed preflight** asserts the burner is on the configured chain with **zero balance and zero nonce** (or aborts the run); message/typed-data signing is allowed (no money moves) but refused for a foreign `chainId`.
- **Gate stubbing.** `web3.stubs` fulfills the app's gate endpoints at the network layer: a whitelist stub AES-encrypts the burner address with the app's own `NEXT_PUBLIC_CRYPTO_KEY` (single source of truth, read from the same QA `.env`) so the app decrypts it to a whitelisted address; geo/health stubs return allowed/healthy. No app code is touched.
- **Branch + worktree boot.** `branch` + `worktree:true` boot a *different* branch (e.g. where the trade UI is live) in a throwaway `git worktree` — the real working tree is never touched — with a gitignored QA `.env.local` and a bounded `install_cmd`. The real backend is **never run**; a loopback-`MONGODB_URI` assertion refuses to drive if the QA env could reach a real DB.
- **Specific / funded wallet (opt-in).** `web3.private_key_env` supplies a chosen key by env-var **name** (value in the gitignored `config/sentinel.env`, never logged), and `web3.allow_funded` relaxes *only* the unfunded preflight — for a **small capped canary** when the UI gates on a real funded venue balance. The broadcast deny-list is unchanged, so Sentinel still never sends an on-chain tx; a real *fill* only occurs if the app submits via its own backend (signed action/API), so the goal must keep size/leverage minimal and close what it opens.

This tests the full wallet-gated frontend (connect → trade form → quotes/validation → the approve/open path) end to end; on-chain submission hits the unfunded wall (`insufficient funds`), which the goal tells the agent is **expected**, so it focuses on rendering/quote/validation/state bugs. For real on-chain *execution* without real money, point `web3.rpc` at a local `anvil --fork-url` of the chain (the deny-list still blocks accidental mainnet broadcast).

## 6. Models

| Role | Model |
|---|---|
| QA decisions, flow derivation, review | **Mimo `mimo-v2.5-pro`** (`pi`, provider `xiaomi`) — fast, cheap |
| Vision (UI/UX review) | **`mimo-v2-omni`** (Xiaomi API direct) |
| docs-sync edits | **claude** (reliable surgical Markdown edits in a worktree) |
| brain-sync distillation | **claude** (surgical single-file edits in a brain worktree, Bash disallowed) |
| review (optional, deeper) | **codex `gpt-5.5`** read-only sandbox |

## 7. Safety

- LLMs only ever receive browser/API tools — no shell/filesystem access. review uses a read-only sandbox; docs-sync is worktree-isolated + docs-only-guarded with no auto-merge.
- brain-sync is worktree-isolated on the **brain** repo (a *different* repo than the one whose cadence fired) under a dedicated brain-repo lock, guarded by **path** (single per-repo file) **and content** (secret scan) with no auto-merge; the global `BRAIN_PATH`/`ENABLE_BRAIN_PR` gate it, and a failed window holds the diff baseline so nothing is silently lost.
- `ai_allowed` per target gates external-model egress. Proprietary repos are added deliberately.
- qa boots on localhost, tears down the full process tree, and reaps ports/orphans on every exit path.
- Per-run wall timeout, per-call timeouts, single-flight tick lock, and lock-age reclaim keep a stuck agent from blocking the fleet. Notifications are summaries only.

## 8. Deliberately out of scope (for now)
Auto-merge, fully autonomous fix loops, a web dashboard, parallel ticks, and seeding proprietary work repos by default — each an earned later capability; security and durability come first.
