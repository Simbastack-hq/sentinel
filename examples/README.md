# Examples

Copy-paste starting points — not prose to read. Each file is a complete, working config you can
drop in and adjust. Pick the one closest to what you want, copy it to `config/targets.json`
(gitignored), and change the paths.

## Target registries (`examples/targets/`)

Each is a full `config/targets.json`. Copy the whole file, or lift one target/agent block into yours.

| File | What it sets up |
|---|---|
| [`targets/review-only.json`](targets/review-only.json) | Watch one repo, **review** the diff on every commit. No app to boot — the simplest possible Sentinel. |
| [`targets/qa-simple-webapp.json`](targets/qa-simple-webapp.json) | **qa** `pi-native` engine: boot a single-process web app and exercise one goal every 12h. |
| [`targets/qa-fullstack-flow.json`](targets/qa-fullstack-flow.json) | **qa** `flow` engine: autonomous deep **FE+BE** test of a web+API stack behind a login. |
| [`targets/docs-sync.json`](targets/docs-sync.json) | **docs-sync**: keep a repo's Markdown in step with its code, as a docs-only PR. |
| [`targets/brain-sync.json`](targets/brain-sync.json) | **brain-sync**: distill each repo's important changes into the shared **simbastack-brain** knowledge repo, as a PR. |
| [`targets/full-fleet.json`](targets/full-fleet.json) | One target running **all four** agents together — the realistic "watch everything" setup. |

## Brain scaffold (`examples/brain-scaffold/`)

`brain-sync` writes into a `30-engineering/` section of the **simbastack-brain** repo. That section
has to exist first (the single-file guard won't let the agent create its own scaffolding). These are
the files to commit **once** into `simbastack-brain` to seed it — ready to use, not a description:

| File here | Commit it to (in simbastack-brain) |
|---|---|
| [`brain-scaffold/section-README.md`](brain-scaffold/section-README.md) | `30-engineering/README.md` |
| [`brain-scaffold/_template.md`](brain-scaffold/_template.md) | `30-engineering/_template.md` |
| [`brain-scaffold/repos-gitkeep.md`](brain-scaffold/repos-gitkeep.md) | `30-engineering/repos/README.md` (so the dir exists) |
| [`brain-scaffold/CLAUDE-routing-snippet.md`](brain-scaffold/CLAUDE-routing-snippet.md) | paste its row into the brain's `CLAUDE.md` routing table |

See [`brain-scaffold/SETUP.md`](brain-scaffold/SETUP.md) for the three commands to wire brain-sync up end-to-end.
