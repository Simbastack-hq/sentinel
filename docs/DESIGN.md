# Sentinel — Design & How It Works

Sentinel is a set of long-running, **specialized** agents that each do one job unattended on a schedule:
code **review**, **docs-sync**, and **QA**. It is self-contained — no external project dependencies, only
the CLIs it shells out to (`pi`/Mimo, `claude`, `codex`, `gh`, Playwright).

## 1. The heartbeat

```
launchd ──(every SCHEDULER_INTERVAL, default 900s)──▶ sentinel tick
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

**Cadence:** `on-commit` compares `git HEAD` to the stored `lastRunSha`; `every:<dur>` compares `now − lastRunEpoch`. State in `var/state/` survives reboots.

## 2. review

Computes the diff since the last reviewed SHA (first run: last `REVIEW_LOOKBACK` commits, or the root commit on shallow repos — using `git rev-parse --verify -q` so a missing `HEAD~N` fails cleanly). The diff is embedded in a prompt (truncated to `MAX_REVIEW_DIFF_CHARS`) and sent to a read-only engine — **Mimo** by default (`pi`, fast/cheap), or `codex`/`claude`. The model ends with a `SENTINEL_VERDICT`/`SENTINEL_FINDINGS` footer that's parsed. Bounded by `REVIEW_TIMEOUT` so a stalled call can't jam the scheduler. Never writes; optional PR comment.

## 3. docs-sync

Creates a throwaway `git worktree` at HEAD, runs `claude` scoped to edit only Markdown, then **hard-guards the result**: every changed path must match a doc allow-list (`*.md`, `docs/**`, `README*`, …) and must not match a code/config denylist — one offending file and **all changes are discarded** (`git reset --hard`). If only docs changed it emits a patch (default) or opens a PR; it **never auto-merges** and never touches the real working tree.

## 4. qa — three engines

Shared boot path (in `agents/qa.sh`): pre-check every port is free (won't boot over / kill a process it didn't start) → boot `start_cmd` on localhost (plain background boot so interactive dev servers like `next dev` survive — a detached session would kill them) → health-check the web port → wait for `aux_ports` (e.g. the API) → run the engine → tear down the **whole process tree** (kill the boot pid + children, reap the ports, and `pkill` by repo path/basename to catch `pnpm --filter`/`tsx watch` stragglers).

### node-loop (v1)
A deterministic Node loop (`bin/qa-drive.js`) owns control flow; Mimo is a **toolless one-shot brain** (`pi -nt`) called once per step (observe DOM → decide action → Playwright executes). Cheapest, most predictable.

### pi-native (v2)
A pi extension (`pi-ext/qa-browser/`) registers Playwright-backed tools; **Mimo drives them inside pi's own agent loop** with full session memory. Deeper exploration of a single goal.

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
- **recon (deterministic) before derive (model):** blind LLM exploration of a monorepo is slow; a fast grep/find digest is what the model actually needs to reason well.
- **`api_request` tool:** runs `fetch` *inside the page*, reusing the frontend's own captured `Authorization` header — so it asserts real backend state (record fields, status transitions, availability) with the logged-in session. This is how it catches backend-only bugs and UI↔backend mismatches.
- **Multi-attempt union:** a single autonomous run is non-deterministic (one attempt may find 0 bugs, another 5). Running each flow N times and unioning findings turns that variance into reliable coverage.
- **Hard step cap:** a soft "you're over budget" nudge gets ignored; the action tools physically refuse past `FLOW_STEPS`, bounding cost and wall-clock.

## 5. Login & UI/UX vision

- **Login** (optional, `qa.app.login`): before exploration the extension navigates to the login path, fills email/password from env vars (Playwright `fill` + a hydration-safe retype, since React controlled inputs can drop a too-early fill), and submits. Credentials come from `config/sentinel.env` by env-var name — **never** placed in the model prompt, trace, or logs. A same-origin nav guard keeps the agent from wandering off and losing its session.
- **UI/UX review:** `mimo-v2.5-pro` is text-only, so vision uses **`mimo-v2-omni`** via the Xiaomi API directly (pi only registers the text Mimo models). `uiux-review.js` sends each key screen with a structured rubric (hierarchy, spacing, contrast/WCAG, typography, consistency, usability/Nielsen, states, density) and parses JSON findings. (omni is a reasoning model — it needs generous `max_tokens` or it cuts off before emitting JSON.)

## 6. Models

| Role | Model |
|---|---|
| QA decisions, flow derivation, review | **Mimo `mimo-v2.5-pro`** (`pi`, provider `xiaomi`) — fast, cheap |
| Vision (UI/UX review) | **`mimo-v2-omni`** (Xiaomi API direct) |
| docs-sync edits | **claude** (reliable surgical Markdown edits in a worktree) |
| review (optional, deeper) | **codex `gpt-5.5`** read-only sandbox |

## 7. Safety

- LLMs only ever receive browser/API tools — no shell/filesystem access. review uses a read-only sandbox; docs-sync is worktree-isolated + docs-only-guarded with no auto-merge.
- `ai_allowed` per target gates external-model egress. Proprietary repos are added deliberately.
- qa boots on localhost, tears down the full process tree, and reaps ports/orphans on every exit path.
- Per-run wall timeout, per-call timeouts, single-flight tick lock, and lock-age reclaim keep a stuck agent from blocking the fleet. Notifications are summaries only.

## 8. Deliberately out of scope (for now)
Auto-merge, fully autonomous fix loops, a web dashboard, parallel ticks, and seeding proprietary work repos by default — each an earned later capability; security and durability come first.
