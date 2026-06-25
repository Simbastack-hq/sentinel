# Most "AI QA" is just a clicker. We built one that reads your code first.

*Point a typical AI testing agent at your app and it loads a page, clicks a few things, flags a console error, and stops. It never learns what the product is for. Sentinel does: it reads the codebase, works out the real business flows, and tests them end to end across the frontend and the backend. It's open source under MIT.*

## The gap between clicking and understanding

If you've put an AI agent on your app, you know the pattern. It opens a page, clicks a few buttons, notices a misaligned element or a console error, and calls the run done. That's useful the way a smoke test is useful, but it's a clicker. It has no model of what your product actually does.

A QA engineer worth hiring doesn't click around. They learn the product first, then reason about it: this is a hotel system, so I need to test a single booking, a group booking, a cancellation that frees the room back up, check-in, check-out, and the night audit, and I need to confirm each one actually persisted on the server instead of trusting that the UI looked happy. The distance between those two behaviors is the whole problem, and closing it is what we set out to do.

## What happened when we gave it a real app and no instructions

We pointed Sentinel at a working full-stack hotel PMS: a Next.js frontend, a separate API service, a Postgres database. No test plan, no script, no list of flows. Just the repo and admin credentials for a throwaway test tenant with disposable data.

It read the code, concluded the product was a boutique and safari hotel PMS, and derived nine critical business flows on its own: the reservation lifecycle, group bookings, cancellations, check-in by token, the night audit, payment to invoice to refund. That's close to the list a human QA lead would write on day one, and nobody handed it to the agent.

Then it ran them, and the trace read like watching a person work:

- It called `GET /api/availability`, got a `400`, worked out the params it was missing, and retried with `adults=2&children=0` to get a `200`.
- It created a real reservation with `POST /api/reservations` (`201`), then fetched it back to confirm it had persisted with the right room and rate.
- It walked the status lifecycle, found the check-in endpoint by trial (`/checkin` gave `404`, `/check-in` gave `400`, then a valid call returned `200`), and checked the folio.

The bugs it surfaced are ones a clicker structurally cannot find:

- Confirming a reservation returned `NO_AVAILABILITY`, even though that same reservation already held the room. A backend state-machine bug, invisible from the UI.
- The calendar showed a room as available after a booking already existed for it. The API and the UI disagreed, and only checking both layers caught it.
- Check-in returned `200`, but a related status never flipped on the server.

You find those by creating data and then inspecting both layers. A screenshot tells you none of it.

## How it works

The QA agent runs a `flow` engine, a pipeline of five steps:

1. Read the repo. A fast deterministic pass extracts the structure: frontend routes, API route modules, services, database entities. The model reasons over that digest instead of crawling a monorepo blind, which is slow and misses things.
2. Derive the flows. Mimo, the model we run for decisions through the `pi` agent harness, turns the digest into a prioritized list of end-to-end business flows, each with UI steps, backend assertions, and edge cases. The plan is cached per commit, so it only re-derives when the code changes.
3. Execute deeply. Each flow runs as an agent loop: the model decides the next action, Playwright drives the browser, and a first-class `api_request` tool calls the backend with the app's own logged-in session to check server state at each step. The model only ever gets browser and API tools. It never touches your shell or filesystem.
4. Run it more than once. Autonomous agents are non-deterministic, and we measured it: on one flow, one attempt found zero bugs and another found five. So each flow runs several attempts and the findings are unioned, which is how you turn that variance into coverage you can trust.
5. Grade the design. Every screen the agent visits also gets a vision pass from a multimodal model, scoring visual hierarchy, spacing, color contrast against WCAG, typography, and broken states. That's the layer a DOM-only check can't see.

All of it runs on a schedule, on a fifteen-minute heartbeat, next to two sibling agents: a code-review agent that reads each new diff, and a docs-sync agent that updates your Markdown to match the code inside an isolated worktree, hard-guarded so it can only touch docs and never auto-merges.

## How we got here

Mimo is where we started, not where we landed after a tournament. The setup was already running on the machine: the `pi` agent harness pointed at Mimo, Xiaomi's model family. So the first question was never which vendor to pick, it was whether a cheap model could drive a browser well enough to matter, and the first answer was no.

Version one was a deterministic Node loop. The script owned control flow and called Mimo as a toolless one-shot brain, once per step: here is the DOM, name the single next action, and the loop ran it through Playwright. It worked on something simple. Against a small product-search app (upload a photo, get visually similar items), it found real bugs, including prices truncated mid-value like "₹4,19" and cards cut off, for less than half a cent a run ($0.0044). But the loop was the ceiling. The model saw one step at a time with no memory of why it took the last one, so it never accumulated enough context to test a flow with more than a couple of moves. It couldn't get past clicking around a single page.

So we gave the loop to the model. Version two, which we called pi-native, registers Playwright-backed browser tools as a pi extension and lets Mimo drive them inside pi's own agent loop, with full session memory. It went deeper on a single goal. But it still needed a goal, and writing goals by hand is the exact chore we were trying to delete.

Version three is the flow engine described above: read the repo, derive the flows, run each one against the browser and the backend. That was the one worth keeping.

## Why Mimo, and what the first runs broke

The model choice got more interesting when we added the design review. We sent screenshots to Mimo for a UI/UX pass and got nonsense back, because the model we were running, `mimo-v2.5-pro`, is text-only. The fix was to read what the Xiaomi API actually serves: alongside the text models it has `mimo-v2-omni`, which is multimodal. Vision now calls omni directly, since the `pi` harness only registers the text Mimo models. omni is a reasoning model and kept cutting off before it emitted its JSON verdict, until we gave it a much larger token budget. A small thing that ate an afternoon, which is exactly why it's worth writing down.

We do run other models, just not in the hot loop. claude makes the surgical Markdown edits for the docs-sync agent inside a guarded worktree, where precision matters more than price and it runs rarely. codex, on gpt-5.5, sits in as an optional read-only review engine for when you want a slower, deeper second opinion. What kept Mimo as the default for the always-on work is frequency. The whole premise is a fifteen-minute heartbeat re-running review and QA across every repo you give it, and at that cadence cost is a design constraint rather than an afterthought. A Mimo decision is a fraction of a cent, a shallow QA run is a few cents, and the deepest multi-attempt run on the hotel PMS topped out around $1.95. That number is what makes "leave it running on everything" a real plan instead of a slogan.

The first full run against a real full-stack app is where the integration bugs lived, and none of them were the model's fault. Our boot wrapper detached the dev server's session and `next dev` quietly died, so we went back to a plain background boot with a teardown that reaps the whole process tree. Playwright filled the login form before React had hydrated, the empty submit came back a `400`, and a hydration-safe retype that verifies the field actually holds its value fixed it. The frontend spoke to `localhost` while the agent used `127.0.0.1`, so CORS blocked every call, an hour lost to a one-line config. The backend assertions returned `401` until we stopped reconstructing the auth token and simply reused the Authorization header the frontend was already sending. Unglamorous, all of it, and precisely the work that decides whether an agent runs on your app or only in a demo.

## Why it's the part that was missing

You don't write or maintain a single test. You point it at a repo, it comprehends the app and tests it, and when the product changes it re-derives the flows. Because it asserts server state through `api_request`, it catches data-integrity and state-machine bugs, not only the visual ones a screenshot would surface. The recon-then-derive step is generic, so the hotel PMS was just our demo; the same pipeline runs against any repo.

And we didn't paper over the awkward part. A single autonomous run is a coin flip on depth, so we engineered around it with multi-attempt unioning and a hard per-attempt step budget that keeps a run both deep and bounded in cost.

## The hard one: QA an app you can't even log into

Plenty of apps don't have a login form. They have a Connect Wallet button, and everything past it is gated behind MetaMask or Rabby. A headless agent can't click a browser-extension popup, so for a while those apps were out of reach.

The way in was cleaner than we expected, and it never touched the app's code. A web3 app talks to its wallet through a standard interface: `window.ethereum`, or for newer apps an EIP-6963 announcement the wallet broadcasts to the page. So before the page loads, Sentinel injects its own implementation of that interface, backed by a throwaway private key it keeps in Node. To the app it looks like an ordinary MetaMask. To us it's a wallet the agent can drive, so the app connects, reads the chain, and signs exactly as it would for a real person, and the key never crosses into the page.

The catch is that these are real apps on a real chain with real money. Point a funded wallet at a live exchange and "QA" can quietly become "opened a leveraged position." So the wallet is a freshly generated, unfunded burner, and we made spending impossible even under misconfiguration: no method that submits a transaction is ever forwarded to the network, full stop. We had an adversarial pass go hunting for holes in that promise, and it paid for itself. The first cut checked the wallet's balance and bailed if it held funds, but the check passed silently whenever the balance lookup failed, which is precisely the moment you'd want it to stop. We fixed it to fail closed, then stopped trusting the balance at all: broadcasting is blocked by method name, structurally, so funding doesn't enter into it. Reads go through, sends never do, and a key that has ever been used aborts the run.

Then we pointed it at a live perpetuals exchange on Arbitrum, and the boring problems arrived on schedule. The landing page fetched a backend during server rendering, so with no backend it returned a 500 and the health check never went green; we started the agent on the trading route instead. The public RPC handed back a malformed CORS header, so the app's own on-chain reads failed and the console filled with tens of thousands of errors; we routed those RPC calls back through Node, where CORS doesn't apply and we could retry the flaky ones. A wallet SDK with a placeholder project id threw an error that tripped the framework's full-screen dev overlay, and the overlay silently swallowed every click, so the agent declared the whole page broken; we tore the overlay down and capped the error stream so a noisy app can't bury a run again.

What came out was a real report. On an unfunded burner the agent connected, opened the isolated-margin trade screen, and worked the form like a tester: no order preview after entering collateral, no slippage control anywhere in the UI, no balance check (it typed 999,999 and the form shrugged), a wallet connection that silently dropped when you switched margin modes, a leverage slider leaking an internal id as its label, and a negative amount the validation only half-caught. Nine functional bugs and thirteen design findings in a forty-nine-step session, for twenty-eight cents, with not one transaction ever reaching the chain.

## The stack

Sentinel is deliberately boring to operate: bash and Node scripts, a launchd scheduler, and the CLIs it shells out to. There's no service to host and no database of its own, and you can read the whole thing in an afternoon. That last part is on purpose; an unattended agent you can't audit is one you shouldn't be running.

## What it can't do yet

It isn't magic. Exploration still varies run to run, which is why we run several attempts. Booting a complex stack takes the right config: ports, auth, a test database, and you should never point write-capable QA at production data. Depth trades off against time and cost, both of them knobs you set. For wallet apps it drives an unfunded burner, so it tests everything up to the moment of settlement, not a trade actually filling; a local chain fork lifts that when you need it. We'd rather write that down than sell you perfection.

## Try it

Sentinel is MIT-licensed and on GitHub: [github.com/Simbastack-hq/sentinel](https://github.com/Simbastack-hq/sentinel).

```bash
git clone https://github.com/Simbastack-hq/sentinel.git && cd sentinel
npm install && cp config/sentinel.env.example config/sentinel.env
cp config/targets.json.example config/targets.json   # register your repo
bin/sentinel doctor && bin/sentinel run <your-app> qa
```

Point it at something real and see what it finds. PRs and issues welcome.

— Hemanshu, building Sentinel
