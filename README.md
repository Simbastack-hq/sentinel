# Sentinel

**24/7 specialized AI agents that watch your repos and apps and do one job well, unattended.**

Sentinel runs three kinds of agents on a schedule:

| Agent | What it does | Writes? |
|---|---|---|
| **review** | Reviews the git diff since its last run and posts a findings report. | no (read-only) |
| **docs-sync** | Updates Markdown docs to match the code, in a throwaway worktree, hard-guarded to **docs-only**; emits a patch or PR. | docs only, **never auto-merges** |
| **qa** | Boots the app and tests it — from a quick UI sweep up to an **autonomous, codebase-aware, deep frontend+backend test suite** that derives the real business flows from your code and exercises them end-to-end. | no (read-only vs the app) |

A launchd heartbeat (`sentinel tick`, every 15 min) checks each target's cadence and runs only what's due. It's self-contained — it only shells out to the CLIs it drives (`pi`/Mimo, `claude`, `codex`, `gh`, Playwright).

---

## The headline: the `qa` flow engine

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
- For the agents you enable: **claude** (docs-sync, optional review), **codex** (optional review).

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

## Usage

```bash
sentinel tick                 # evaluate cadences, run what's due (launchd runs this)
sentinel run <target> <agent> # run one now: review | docs-sync | qa
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
| `start_cmd`, `port`, `health_path` | how to boot the app + the URL to health-check |
| `set_port:false` | multi-process stacks (web+api) — don't force one `PORT` on every child |
| `aux_ports` | extra services to wait for + reap (e.g. the API on `4000`) |
| `host` | browser origin — `localhost` vs `127.0.0.1` (matters for CORS/sessions) |
| `api_base` | backend base URL for the flow engine's `api_request` assertions |
| `login` | `{path, email_env, password_env}` — Playwright fills the form from env vars (never sent to the model or logged) |
| `goal` | (pi-native/node-loop only) what to exercise |

Credentials referenced by `email_env`/`password_env` live only in `config/sentinel.env` (gitignored), keyed by the **name** you put in `targets.json`.

### Tuning the flow engine (env or `config/sentinel.env`)
`FLOW_MAX` (flows per run, default 2) · `FLOW_ATTEMPTS` (attempts per flow, default 2) · `FLOW_STEPS` (hard tool-call cap per attempt, default 90) · `RUN_WALL_TIMEOUT` (per-run wall cap, default 3600s). A full 2×2 deep run is ~40 min / ~$2 of Mimo.

## Safety model

- **review** is read-only (sandboxed). **docs-sync** runs in an isolated git worktree with a docs-only allow-list — one non-doc change discards everything; it never auto-merges. **qa** is read-only against the app, boots it on localhost, and tears down the whole process tree (incl. orphans).
- The LLM only ever gets browser/API tools — no shell/filesystem access.
- `ai_allowed` per target gates sending a repo's code/DOM/diff to external models. **Work/proprietary repos are not seeded** — add them deliberately.
- Notifications carry summaries only; credentials are filled into forms by Playwright and never enter prompts, traces, or logs.

## Repo layout

```
bin/        sentinel (CLI) · recon.js · pi-ask.js · qa-drive.js · mimo-vision.js · uiux-review.js · merge-flows.js · render-report.js
agents/     review.sh · docs-sync.sh · qa.sh
lib/        common.sh  (shared: env, cadence, locking, accessors)
pi-ext/     qa-browser/  (pi extension: Playwright-backed browser + api_request tools)
config/     *.example  (copy to the real, gitignored files)
launchd/    com.sentinel.scheduler.plist
docs/       DESIGN.md
```
