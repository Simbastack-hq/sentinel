# 30 — Engineering

One file per code repo, capturing the **important, public-safe** engineering changes the rest of the
team should know about: conventions, architecture decisions, API/interface changes, and dependency/infra
shifts. These files are maintained automatically by **Sentinel's `brain-sync` agent** (one PR per repo,
human-reviewed, never auto-merged) — but anyone can edit them by hand too.

## Layout

```
30-engineering/
  README.md            ← this file
  _template.md         ← the shape every repo file follows
  repos/
    <repo>.md          ← one per watched repo (brain-sync writes these)
```

## How to read these

Each `repos/<repo>.md` is an **append-only dated log**, newest entries at the top, under four sections:

- **Skills & conventions** — coding conventions, lint/test/CI commands, branch & PR norms, naming.
- **Architecture & decisions** — modules/services and how they fit; design decisions and *why*.
- **API / interface changes** — public HTTP/MCP/CLI/SDK surface; breaking or additive changes.
- **Dependencies & infra** — notable deps, runtime/services, deploy targets, env-var *names*, migrations.

Each bullet is keyed by the source commit short-SHA, so entries are stable and don't churn.

## Public-safe rule

The brain's [one hard rule](../CLAUDE.md) applies here too — these files are read by the whole team:
**no secrets, tokens, .env values, pricing internals, net rates, or customer/guest PII.** API shapes and
env-var *names* are fine; values never are. `brain-sync` enforces this with a secret-content scan before
any PR, but treat it as a floor, not a ceiling.
