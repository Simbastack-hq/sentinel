# Contributing to Sentinel

Thanks for your interest! Sentinel is a small, hackable system — bash + Node, no build step.

## Dev setup

```bash
git clone https://github.com/Simbastack-hq/sentinel.git && cd sentinel
npm install && ( cd pi-ext/qa-browser && npm install )
cp config/sentinel.env.example config/sentinel.env
cp config/targets.json.example config/targets.json
bin/sentinel doctor   # checks pi/Mimo, claude, codex, gh, playwright, ntfy
```

You'll need the prerequisites listed in the [README](README.md#prerequisites) (notably `pi` authed for the Xiaomi/Mimo provider).

## How the pieces fit

- **`bin/sentinel`** — CLI + orchestration; `tick` is the scheduler heartbeat, `run` forces one agent.
- **`lib/common.sh`** — shared contract: env loading, cadence, locking, `targets.json` accessors, `run_to`.
- **`agents/*.sh`** — one file per agent. The contract is simple: read env (`RUN_DIR`, `TARGET`, `TARGET_PATH`, …), do the work, write `report.md` + `result.json` (`{verdict, summary, findings, cost, skipped, sha}`).
- **`bin/*.js`** — helpers: `recon` (repo digest), `pi-ask` (Mimo text), `qa-drive` (node-loop driver), `mimo-vision`/`uiux-review` (vision), `merge-flows`, `render-report`.
- **`pi-ext/qa-browser/`** — the pi extension exposing Playwright-backed browser + `api_request` tools.

See [`docs/DESIGN.md`](docs/DESIGN.md) for the full architecture and the reasoning behind each design choice.

## Guidelines

- **Keep agents to the contract.** New agent → new `agents/<name>.sh` that emits `report.md` + `result.json`; register it in `bin/sentinel`'s `VALID_AGENTS`.
- **Never commit secrets or runtime data.** `config/sentinel.env`, `config/targets.json`, and `var/` are gitignored — keep it that way. Credentials are referenced by env-var *name* in the registry and filled by Playwright, never placed in prompts/logs.
- **Safety first.** The LLM only ever gets browser/API tools — no shell/filesystem. Respect `ai_allowed`. Keep `docs-sync`'s docs-only guard and qa's "never touch a process we didn't start" intact.
- **Match the surrounding style.** Bash is `set -uo pipefail`; prefer the existing helpers in `common.sh`. JS is plain Node (no transpile).
- **Test your change** by running the relevant agent on a sample target (`bin/sentinel run <target> <agent>`) and checking the report + a clean teardown (no orphan processes / freed ports).

## Pull requests

Small, focused PRs with a clear description of *what* and *why*. If you're adding a capability (a new engine, tool, or agent), a note in `docs/DESIGN.md` is appreciated. Open an issue first for anything large so we can align on the approach.
