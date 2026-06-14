# Sentinel: an AI QA agent that *understands your product*

*Most "AI QA" tools click around your UI and report what looks broken. We wanted one that tests like a senior QA engineer — that reads your codebase, figures out the real business flows on its own, and exercises them end-to-end across the frontend **and** the backend. This is Sentinel, and it's open source.*

---

## The gap

If you've tried an AI agent on your app, you've seen the pattern: it loads a page, clicks a few buttons, notices a console error or a misaligned button, and calls it a day. Useful — but it's a *clicker*. It has no idea what your product actually *does*.

A real QA engineer doesn't click randomly. They learn the product, then think: *"This is a hotel system. So I need to test creating a single booking, a group booking, a cancellation that should free the room back up, check-in, check-out, and the night audit. And I need to verify the booking actually persisted on the server — not just that the UI looked happy."*

That gap — between **clicking a UI** and **understanding a product** — is the whole game. So we built an agent that closes it.

## The "aha"

We pointed Sentinel at a real, full-stack hotel PMS (Next.js frontend, a separate API, a Postgres database) and gave it **no test plan** — just the repo and admin credentials for a throwaway test tenant.

It read the code, decided the product was a *"boutique/safari hotel PMS,"* and derived nine critical business flows on its own — the reservation lifecycle, group bookings, cancellations, check-in via token, the night audit, payment → invoice → refund. Exactly the list a human QA lead would write.

Then it *tested* them. Watching the trace of the reservation-lifecycle flow felt like watching a person:

- It hit `GET /api/availability`, got a `400`, **figured out the required params**, and retried with `&adults=2&children=0` → `200`.
- It **created a real reservation** (`POST /api/reservations → 201`), then `GET`-ed it back to confirm it persisted with the right room and rate.
- It drove the status lifecycle, **discovered the check-in endpoint by trial** (`/checkin → 404`, `/check-in → 400`, … → `200`), and verified the folio.

And it found bugs a click-bot structurally *cannot*:

- A **backend state-machine bug**: confirming a reservation returned `NO_AVAILABILITY` even though the reservation already held the room.
- A **UI↔backend mismatch**: the calendar showed a room as "available" *after* a booking existed for it — the API and the UI disagreed.
- Check-in returned `200`, **but a related status never updated** on the server.

You only catch those by *creating data and checking both layers*. That's the point.

---

## How it works

Under the hood, the QA agent's `flow` engine is a pipeline:

```
recon (read the repo)  →  Mimo derives the business flows  →  deep multi-attempt execution  →  union → report
   routes, API modules,        cached per commit              FE (Playwright) + BE (api_request)
   services, DB schema                                        asserting state at each step
```

1. **Understand** — a fast, deterministic pass extracts the app's structure (frontend routes, API route modules, services, DB entities). A model reasons over *that digest* — not by slowly crawling a monorepo blind.
2. **Derive** — Mimo turns the digest into a prioritized list of end-to-end business flows, each with UI steps, **backend assertions**, and edge cases. Cached per commit.
3. **Execute deeply** — each flow runs as an agent loop: Mimo decides, Playwright drives the browser, and a first-class `api_request` tool calls the **backend** with the app's own logged-in session to verify server state. The model only ever gets browser/API tools — never your shell or filesystem.
4. **Be reliable anyway** — autonomous agents are non-deterministic. On the same flow, one run found 0 bugs and another found 5. So each flow runs **multiple attempts and the findings are unioned** — redundancy turns variance into coverage.
5. **Grade the design** — every screen it visits also gets a vision pass (a multimodal model) scoring visual hierarchy, spacing, **color contrast / WCAG**, typography, consistency, and states — the UI/UX layer a DOM-only check is blind to.

It all runs on a 24/7 schedule (a 15-minute heartbeat), alongside two sibling agents: a **code-review** agent and a **docs-sync** agent (which updates your Markdown to match the code, in an isolated worktree, hard-guarded so it can *only* touch docs and never auto-merges).

## Why this is the missing piece

- **No hand-written tests.** You don't script flows or maintain selectors. Point it at a repo; it comprehends and tests. When the product changes, it re-derives.
- **Frontend *and* backend.** It asserts server state, so it catches data-integrity and state-machine bugs, not just visual ones.
- **Any repo.** The recon→derive step is generic. We demoed a hotel PMS; it works the same on your app.
- **Honest about agents.** A single autonomous run is a coin-flip on depth. We didn't pretend otherwise — we engineered around it with multi-attempt unioning and hard step budgets, so runs are both deep *and* bounded.

## The stack

Sentinel is deliberately boring to run: a set of bash + Node scripts, a launchd scheduler, and the CLIs it drives. The brains are **Mimo** (via the `pi` agent harness) for decisions, flow derivation, and review, with a multimodal Mimo model for vision; **Playwright** is the hands; **claude**/**codex** handle docs and optional deep review. A full deep run is a few cents to a couple of dollars of model usage — cheap enough to run on every repo, on a timer, locally.

## Honest limitations

It's not magic. Agent exploration varies run to run (hence multi-attempt). Booting a complex stack needs the right config (ports, auth, a test database — never point write-capable QA at production data). And the deeper you go, the more it costs and the longer it takes — all tunable knobs. We'd rather tell you that than sell you perfection.

## Try it

Sentinel is **MIT-licensed and open source**: **[github.com/Simbastack-hq/sentinel](https://github.com/Simbastack-hq/sentinel)**

```bash
git clone https://github.com/Simbastack-hq/sentinel.git && cd sentinel
npm install && cp config/sentinel.env.example config/sentinel.env
cp config/targets.json.example config/targets.json   # register your repo
bin/sentinel doctor && bin/sentinel run <your-app> qa
```

QA that reads your code, understands your product, and tests it like a human would — frontend and backend, on autopilot. We think that's the bar AI QA should be held to. Tell us what it finds in *your* app.
