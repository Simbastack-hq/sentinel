# Wiring up brain-sync end-to-end

Three steps: seed the brain's `30-engineering/` section once, point Sentinel at the brain, enable the
agent on the repos you want fed in. brain-sync skips cleanly until all three are done, so order is forgiving.

## 1. Seed the section in simbastack-brain (once)

The single-file guard won't let the agent create its own scaffolding, so commit it by hand first:

```bash
git clone https://github.com/Simbastack-hq/simbastack-brain.git ~/simbastack-brain
cd ~/simbastack-brain
git checkout -b seed-30-engineering

mkdir -p 30-engineering/repos
cp ~/sentinel/examples/brain-scaffold/section-README.md  30-engineering/README.md
cp ~/sentinel/examples/brain-scaffold/_template.md       30-engineering/_template.md
cp ~/sentinel/examples/brain-scaffold/repos-gitkeep.md   30-engineering/repos/README.md
# then paste the row from brain-scaffold/CLAUDE-routing-snippet.md into CLAUDE.md by hand

git add 30-engineering CLAUDE.md
git commit -m "Add 30-engineering section for automated per-repo logs"
git push -u origin seed-30-engineering
gh pr create --fill        # review + merge into main
```

## 2. Point Sentinel at the brain — `config/sentinel.env`

```bash
BRAIN_PATH="$HOME/simbastack-brain"   # the clone from step 1
# BRAIN_GITHUB / BRAIN_BASE default to Simbastack-hq/simbastack-brain @ main
ENABLE_BRAIN_PR=0                      # start in dry-run (local patch). Flip to 1 once output looks right.
```

Confirm with `sentinel doctor` — the `brain repo:` line should read `ok`.

## 3. Enable brain-sync per repo — `config/targets.json`

Add to each repo you want in the brain (see [`../targets/brain-sync.json`](../targets/brain-sync.json)):

```json
"brain-sync": { "enabled": true, "cadence": "every:24h" }
```

## 4. Dry-run, then go live

```bash
sentinel run <target> brain-sync                       # one run now (dry-run)
cat var/runs/<run-id>/artifacts/brain.patch            # inspect what it would write
sentinel report <target> brain-sync                    # the human report
```

When the patches look right, set `ENABLE_BRAIN_PR=1` in `config/sentinel.env`. From then on each due run
opens a PR on simbastack-brain (never auto-merged). The 15-min scheduler picks it up — nothing else to do.
