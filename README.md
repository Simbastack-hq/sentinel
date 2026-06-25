# Sentinel

**24/7 specialized AI agents that watch your repos and apps and do one job well, unattended.**

Sentinel runs four kinds of agents on a schedule:

| Agent | What it does | Writes? |
|---|---|---|
| **review** | Reviews the git diff since its last run and posts a findings report. | no (read-only) |
| **docs-sync** | Updates Markdown docs to match the code, in a throwaway worktree, hard-guarded to **docs-only**; emits a patch or PR. | docs only, **never auto-merges** |
| **qa** | Boots the app and tests it — from a quick UI sweep up to an **autonomous, codebase-aware, deep frontend+backend test suite** that derives the real business flows from your code and exercises them end-to-end. | no (read-only vs the app) |
| **brain-sync** | Distills each repo's important changes (skills/conventions, architecture, API, deps/infra) into a shared team **knowledge repo** as a PR — one per-repo file, append-only dated bullets, single-file + secret-content guarded. | one per-repo file in the brain, **never auto-merges** |

A launchd heartbeat (`sentinel tick`, every 15 min) checks each target's cadence and runs only what's due. It's self-contained — it only shells out to the CLIs it drives (`pi`/Mimo, `claude`, `codex`, `gh`, Playwright).

---

## How it works, in plain terms

Sentinel is a small set of tireless teammates that check your projects on a schedule, each with one job. A **reviewer** reads every new code change and flags what looks wrong. A **docs editor** notices when your README has drifted from the code and writes the fix — as a suggestion you approve, never a silent change. A **knowledge keeper** quietly records what each repo learned this week into one shared team doc. And a **QA tester** actually uses your app.

That last one is the part that's different. Most automated testers click around a screen and report if something looks off. Sentinel's reads your code first to work out what the product *is* — point it at a hotel booking app and it figures out, on its own, that it should test making a booking, checking a guest in, cancelling one, and running the nightly close. Then it does exactly that: it creates a real booking, confirms it actually saved on the server (not just that the screen looked happy), pokes at the edge cases a careful tester would, and writes up what broke — both what the guest sees and what's happening behind the scenes.

You don't write a single test. You point it at a repo and it works the rest out. It runs while you sleep, so you wake up to a report instead of a 2 a.m. bug.

---

## The `qa` flow engine — testing that understands your product

Point the `qa` agent at any web app with `engine: "flow"` and, **without you writing a test plan**, it:

1. **Understands the product** — `recon` reads the repo's routes, API modules, services, and DB schema; Mimo derives the critical end-to-end business flows (cached per commit). *On a hotel PMS it independently produces flows like "Book → Check-in → Night Audit → Checkout", "Group Reservation", "Cancellation → availability release", "Payment → Invoice → Refund".*
2. **Tests each flow deeply** — a Mimo + Playwright agent drives the UI **and** asserts the **backend** via a real authenticated `api_request` tool (it creates a reservation via the API, verifies it persisted, drives status transitions, checks the folio…).
3. **Is reliable despite a non-deterministic agent** — each flow runs **N attempts** and findings are **unioned + deduped** (one attempt finds 0 bugs, another finds 5 → you get all 5).
4. **Adds a UI/UX review** — every captured screen is graded by a vision model (`mimo-v2-omni`) on hierarchy, spacing, **contrast/WCAG**, typography, consistency, usability, and states.

Output: one combined `report.html` + `report.md` with per-flow verdicts, a deduped **FE+BE bug list**, UI/UX findings, and per-attempt screenshot traces.

The other two `qa` engines are lighter: **`pi-native`** (single-goal agentic exploration) and **`node-loop`** (deterministic, cheapest).

---

## How it works

```
launchd ──(every 15 min)──▶ sentinel tick ──┐  single-flight lock
                                            ▼
            for each target × enabled agent: is its cadence due?
                                            │ yes
                                            ▼
                          agents/<agent>.sh  (review | docs-sync | qa)
                                            │
                  writes report.md + result.json → reports/ + ntfy push

qa engine "flow":
  recon.js (digest)  →  Mimo derives flows (cached)  →  for each flow:
     N attempts × [ Mimo + Playwright + api_request, hard step cap ]  →  union/dedup
  →  UI/UX vision pass (mimo-v2-omni)  →  merge → combined report.html/json
```

- **Brains:** Mimo (`pi`, provider `xiaomi`) makes decisions and derives flows; `mimo-v2-omni` does vision (UI/UX). `claude` does docs edits; `codex`/`claude`/Mimo do code review (configurable).
- **Hands:** Playwright drives a headless browser. The LLM stays a decision-maker calling tools — it never touches your filesystem or shell.
- **Backend assertions:** the `api_request` tool runs `fetch` inside the page, reusing the app's own auth header, so it verifies server state, not just the UI.

Full architecture: [`docs/DESIGN.md`](docs/DESIGN.md).

---

## Prerequisites

Installed and on `PATH`:

- **[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)** — the agent harness, authed for the **Xiaomi/Mimo** provider (`pi` uses `~/.pi/agent/auth.json`; the vision helpers read `.xiaomi.key` from there, or `$XIAOMI_API_KEY`).
- **node** ≥ 20, **jq**, **git**, **gh** (authed: `gh auth login`), **curl**, **lsof**, **gtimeout** (`brew install coreutils`), **python3**.
- **Playwright** (installed by `npm install`; reuses the shared chromium cache).
- For the agents you enable: **claude** (docs-sync, brain-sync, optional review), **codex** (optional review).
- **brain-sync** also needs a local clone of the shared knowledge repo at `BRAIN_PATH` (origin matching `BRAIN_GITHUB`) and `gh` with write access to it. See [`examples/brain-scaffold/SETUP.md`](examples/brain-scaffold/SETUP.md).

Check everything with `sentinel doctor`.

## Setup

```bash
git clone https://github.com/Simbastack-hq/sentinel.git ~/sentinel
cd ~/sentinel
npm install                              # Playwright (+ chromium)
( cd pi-ext/qa-browser && npm install )  # browser-tool extension deps

cp config/sentinel.env.example config/sentinel.env   # set a private NTFY_TOPIC; add login creds here
cp config/targets.json.example config/targets.json   # register your repos

bin/sentinel doctor                      # verify pi/claude/codex/gh/playwright/ntfy
bin/sentinel run <target> qa             # try one run
bin/sentinel install                     # load the 15-min launchd scheduler (24/7)
```

`config/sentinel.env` and `config/targets.json` are **gitignored** — credentials and your registry stay local.

## Examples

Don't hand-write config from scratch — copy a ready-made one from [`examples/`](examples/README.md) and change the paths:

| Want to… | Start from |
|---|---|
| Review a repo on every commit | [`examples/targets/review-only.json`](examples/targets/review-only.json) |
| Boot + test a simple web app | [`examples/targets/qa-simple-webapp.json`](examples/targets/qa-simple-webapp.json) |
| Deep FE+BE flow test behind a login | [`examples/targets/qa-fullstack-flow.json`](examples/targets/qa-fullstack-flow.json) |
| Keep docs in sync as PRs | [`examples/targets/docs-sync.json`](examples/targets/docs-sync.json) |
| Feed important changes into a shared brain | [`examples/targets/brain-sync.json`](examples/targets/brain-sync.json) + [`examples/brain-scaffold/SETUP.md`](examples/brain-scaffold/SETUP.md) |
| Run all four agents on one repo | [`examples/targets/full-fleet.json`](examples/targets/full-fleet.json) |

## Usage

```bash
sentinel tick                 # evaluate cadences, run what's due (launchd runs this)
sentinel run <target> <agent> # run one now: review | docs-sync | qa | brain-sync
sentinel status               # recent runs (verdict, findings, cost)
sentinel report <target> qa   # print the latest report
sentinel logs <run-id> [n]    # tail a run log
sentinel targets              # registry + what's due
sentinel add-target <key> <path> [base]
sentinel install | uninstall  # load/unload the scheduler
sentinel doctor               # deps + config check
```

Each run's artifacts (combined `report.html`, screenshots, per-attempt traces, JSON) live under `var/runs/<run-id>/artifacts/qa/`.

## Configuring a target

See [`config/targets.json.example`](config/targets.json.example). Key `qa.app` fields:

| field | meaning |
|---|---|
| `engine` | `flow` (autonomous deep FE+BE) · `pi-native` (single-goal explore) · `node-loop` (deterministic) |
| `base_url` | QA an **already-deployed** app at this URL instead of booting locally (no `start_cmd`/`port` needed) — see below |
| `start_cmd`, `port`, `health_path` | how to boot the app + the URL to health-check |
| `set_port:false` | multi-process stacks (web+api) — don't force one `PORT` on every child |
| `aux_ports` | extra services to wait for + reap (e.g. the API on `4000`) |
| `host` | browser origin — `localhost` vs `127.0.0.1` (matters for CORS/sessions) |
| `api_base` | backend base URL for the flow engine's `api_request` assertions |
| `login` | `{path, email_env, password_env}` — Playwright fills the form from env vars (never sent to the model or logged) |
| `goal` | (pi-native/node-loop only) what to exercise |
| `branch` + `worktree:true` | QA a *different* branch in a throwaway `git worktree` (real working tree untouched); `install_cmd` + `qa_env` (a gitignored `.env` dropped in as `.env.local`) |
| `web3` | QA a wallet-gated dApp: inject an **unfunded burner** wallet + stub gate endpoints — see below |

### QA a live/deployed app (no local boot)

Set `base_url` to test an app that's **already running** — a staging deploy, a preview URL, or production — instead of booting it locally. `recon` still reads the local repo to derive the flows; Sentinel just drives the remote origin and asserts its `api_base`. `start_cmd`/`port`/boot/teardown are skipped.

```json
"qa": {
  "enabled": true, "cadence": "every:12h",
  "app": {
    "engine": "flow",
    "base_url": "https://staging.example.com",
    "api_base": "https://api.example.com",
    "allow_live_data": true,
    "health_path": "/"
  }
}
```

The `path` at the target level still points at the local repo (for `recon`). Combine with `web3` to drive a deployed wallet-gated dApp. ⚠️ **Fail-closed safety:** a non-local `base_url` (anything but `localhost`/`127.0.0.1`) is **refused** unless you set `allow_live_data: true` — driving a live origin means QA can act on real data (UI actions *and* authenticated `api_request`), so opt in deliberately and scope the `goal`/flows to read-only or non-destructive actions.

### QA for wallet dApps (web3 mode)

For apps gated behind MetaMask/Rabby, `qa.app.web3` injects a programmatic wallet so the agent can connect and exercise the UI — **without touching the app's code**. It's built to be safe by construction: a **fresh unfunded burner** key held only in Node (never in the page/model/logs), **no transaction is ever broadcast** (deny-by-prefix + a read-only RPC allow-list), and a **fail-closed preflight** aborts if the key is ever funded/used. Gate endpoints (whitelist/geo/health) are stubbed at the network layer.

```json
"web3": {
  "enabled": true,
  "rpc": "https://arb1.arbitrum.io/rpc",     // chain reads (use a keyed/private RPC or an anvil fork for reliability)
  "chain_id": 42161,
  "stubs": [
    { "url": "**/api/records*", "whitelist": true, "json": { "data": [{ "fields": { "Address": "__WL_ADDR__" } }] } },
    { "url": "**/api/country*", "json": { "message": "YES" } }
  ]
}
```

`whitelist:true` splices the burner address (AES-encrypted with the app's own `NEXT_PUBLIC_CRYPTO_KEY`, read from the QA `.env`) into the `__WL_ADDR__` token so the app sees it as whitelisted. `branch` + `worktree:true` let you QA a branch where the gated UI is live, in a throwaway worktree. The full design is in [`docs/DESIGN.md`](docs/DESIGN.md) (§5c). For real on-chain *execution* without real money, point `rpc` at a local `anvil --fork-url`.

Proven against a live wallet-gated perpetuals exchange frontend on Arbitrum: from an unfunded burner the agent connected, opened the trade screen, and surfaced **9 functional bugs + 13 UI/UX findings** in a 49-step session for ~$0.28 — with **no transaction ever broadcast**.

Credentials referenced by `email_env`/`password_env` live only in `config/sentinel.env` (gitignored), keyed by the **name** you put in `targets.json`.

### Tuning the flow engine (env or `config/sentinel.env`)
`FLOW_MAX` (flows per run, default 2) · `FLOW_ATTEMPTS` (attempts per flow, default 2) · `FLOW_STEPS` (hard tool-call cap per attempt, default 90) · `RUN_WALL_TIMEOUT` (per-run wall cap, default 3600s). A full 2×2 deep run is ~40 min / ~$2 of Mimo.

### Configuring brain-sync (env or `config/sentinel.env`)
The brain location is **global** (one brain for all targets): `BRAIN_PATH` (local clone — leave blank to disable), `BRAIN_GITHUB` (default `Simbastack-hq/simbastack-brain`), `BRAIN_BASE` (default `main`), `ENABLE_BRAIN_PR` (`0` dry-run patch / `1` open PR), `MAX_BRAIN_DIFF_CHARS` (default 80000 — above this it sends a stat+commit-log summary), `BRAIN_MIN_DIFF_LINES` (default 8 — trivial windows below this open no PR). Per target you only set `brain-sync: { enabled, cadence }` in `targets.json` (use `every:24h`, never `on-commit`). Full walkthrough: [`examples/brain-scaffold/SETUP.md`](examples/brain-scaffold/SETUP.md).

## Safety model

- **review** is read-only (sandboxed). **docs-sync** runs in an isolated git worktree with a docs-only allow-list — one non-doc change discards everything; it never auto-merges. **qa** is read-only against the app, boots it on localhost, and tears down the whole process tree (incl. orphans).
- **brain-sync** reads a repo's diff (only when `ai_allowed=true`) and edits an isolated worktree of the **brain** repo guarded to a **single per-repo file** — any other changed path discards everything — plus a **secret-content scan** of the staged diff (any match discards everything and wipes the patch). It opens a PR (`ENABLE_BRAIN_PR=1`), never auto-merges, and **holds its diff baseline on any failure** so a window is retried, never silently dropped.
- The LLM only ever gets browser/API tools — no shell/filesystem access.
- `ai_allowed` per target gates sending a repo's code/DOM/diff to external models. **Work/proprietary repos are not seeded** — add them deliberately.
- Notifications carry summaries only; credentials are filled into forms by Playwright and never enter prompts, traces, or logs.

## Repo layout

```
bin/        sentinel (CLI) · recon.js · pi-ask.js · qa-drive.js · mimo-vision.js · uiux-review.js · merge-flows.js · render-report.js
agents/     review.sh · docs-sync.sh · qa.sh · brain-sync.sh
examples/   ready-to-copy targets.json registries + brain-repo scaffold (see examples/README.md)
lib/        common.sh  (shared: env, cadence, locking, accessors)
pi-ext/     qa-browser/  (pi extension: Playwright-backed browser + api_request tools)
config/     *.example  (copy to the real, gitignored files)
launchd/    com.sentinel.scheduler.plist
docs/       DESIGN.md
```

## License & credits

MIT — see [LICENSE](LICENSE).

Built by **[Hemanshu Upadhyay](https://github.com/Hemanshu-Upadhyay)** at **[SimbaStack](https://github.com/Simbastack-hq)**.
