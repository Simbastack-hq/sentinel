#!/usr/bin/env bash
# brain-sync agent — distill IMPORTANT changes from a SOURCE repo's recent diff into the
# SHARED team knowledge repo (Simbastack-hq/simbastack-brain), as a PR. NEVER auto-merges.
# Writes ONLY one per-repo file in the BRAIN repo: 30-engineering/repos/<slug>.md.
# It reads the SOURCE repo READ-ONLY (review.sh's baseline diff) and edits in an isolated
# worktree of the BRAIN repo, hard-guarded to that single file by PATH and scanned for secrets
# by CONTENT before any commit/push. Holds the diff baseline (advance=0) on every failure so a
# dropped window is retried, never silently lost.
# Inputs (env): RUN_ID RUN_DIR TARGET TARGET_PATH TARGET_BASE TARGET_GITHUB AI_ALLOWED
#               + globals: BRAIN_PATH BRAIN_GITHUB BRAIN_BASE ENABLE_BRAIN_PR
#                          CLAUDE_PERMISSION_MODE CMD_TIMEOUT REVIEW_LOOKBACK
#                          MAX_BRAIN_DIFF_CHARS BRAIN_MIN_DIFF_LINES
# Outputs: report.md, result.json (+ artifacts/brain.patch, artifacts/claude.json).
. "$SENTINEL_HOME/lib/common.sh"
set -uo pipefail
path="$TARGET_PATH"; rd="$RUN_DIR"

# result(): adds an `advance` field (0|1). advance=0 => dispatcher must NOT advance lastRunSha
# (the window is retried next tick). advance defaults to 1 (advance) when omitted.
result(){ # verdict summary findings cost skipped sha advance
  jq -n --arg v "$1" --arg s "$2" --argjson f "${3:-0}" --arg c "${4:-}" \
        --argjson sk "${5:-false}" --arg sha "${6:-}" --argjson adv "${7:-1}" \
    '{verdict:$v,summary:$s,findings:$f,cost:$c,skipped:$sk,sha:$sha,advance:$adv}' > "$rd/result.json"
}

# --- hard preconditions on the trust-boundary inputs BEFORE deriving any path ---
# RUN_ID must be non-empty: $wt is built from it, and an empty RUN_ID would make the cleanup
# `rm -rf "$VAR/brain-worktrees/"` wipe ALL brain worktrees. (Set by dispatcher bin/sentinel.)
if [ -z "${RUN_ID:-}" ]; then
  echo "RUN_ID unset — refusing to run (would risk rm -rf of the worktree base)"
  echo "# brain-sync skipped — RUN_ID unset (run via the dispatcher, not directly)" > "$rd/report.md"
  result error "RUN_ID unset" 0 "" false "" 0; exit 0
fi
# $TARGET is a registry key (operator-controlled) and is the SOLE input to the allowed path.
# Sanitize to a filesystem-safe slug so it can never traverse out of 30-engineering/repos/.
slug="$(printf '%s' "$TARGET" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | sed -E 's/-+/-/g; s/^-//; s/-$//')"
if [ -z "$slug" ]; then
  echo "TARGET '$TARGET' has no slug-safe characters"; echo "# brain-sync skipped — TARGET key has no slug-safe form" > "$rd/report.md"
  result error "unsluggable TARGET" 0 "" false "" 0; exit 0
fi
BRAIN_FILE="30-engineering/repos/${slug}.md"
# Belt-and-suspenders: the derived path must never contain traversal or be absolute.
case "$BRAIN_FILE" in *..*|/*) echo "refusing traversal path: $BRAIN_FILE"; echo "# brain-sync skipped — derived brain path is unsafe" > "$rd/report.md"; result error "unsafe brain path" 0 "" false "" 0; exit 0;; esac

# Isolated worktree lives on the BRAIN repo (NOT the source repo) — separate base dir from docs-sync.
WT_BASE="$VAR/brain-worktrees"; mkdir -p "$WT_BASE"
wt="$WT_BASE/$RUN_ID"; branch="sentinel/brain/$RUN_ID"
brain_locked=0

# Cleanup: remove the BRAIN worktree + LOCAL branch on every exit; release the brain-repo lock.
# The pushed REMOTE branch is intentionally KEPT when it backs an open PR (deleting it would break
# the PR). On push-ok-but-PR-failed we delete the remote branch explicitly below, before exit.
cleanup(){
  if [ -n "${BRAIN_PATH:-}" ]; then
    git -C "$BRAIN_PATH" worktree remove --force "$wt" 2>/dev/null || rm -rf "$wt"
    git -C "$BRAIN_PATH" branch -D "$branch" 2>/dev/null || true
  fi
  [ "$brain_locked" = 1 ] && lock_release brain-repo
}
trap cleanup EXIT INT TERM

# ---- guards (skip-and-exit-0). Pre-worktree skips emit advance=1 (truly no real work to retry). ----
[ -d "$path/.git" ] || { echo "not a git repo: $path"; echo "# brain-sync skipped — source is not a git repo" > "$rd/report.md"; result skipped "not a git repo" 0 "" true "" 1; exit 0; }
# Privacy gate: the brain is PRIVATE+SHARED; distilling a repo's diff sends code to an external model.
if [ "$AI_ALLOWED" != "true" ]; then
  echo "ai_allowed=false → not sending source diff to a model"; echo "# brain-sync skipped — ai_allowed is false" > "$rd/report.md"; result skipped "ai_allowed=false" 0 "" true "" 1; exit 0
fi
# Brain repo must be configured + cloned locally.
if [ -z "${BRAIN_PATH:-}" ] || [ ! -d "$BRAIN_PATH/.git" ]; then
  echo "BRAIN_PATH unset or not a git repo: '${BRAIN_PATH:-}'"
  echo "# brain-sync skipped — BRAIN_PATH unset or not a git repo (set it in config/sentinel.env and clone simbastack-brain)" > "$rd/report.md"
  result skipped "BRAIN_PATH unset/not-a-repo" 0 "" true "" 1; exit 0
fi
have claude || { echo "claude CLI missing"; echo "# brain-sync skipped — claude CLI missing" > "$rd/report.md"; result skipped "claude missing" 0 "" true "" 1; exit 0; }

# ---- source diff since last brain-sync (review.sh mechanism; state key: brain-sync lastRunSha) ----
# $head = current source HEAD (advance target). $last = prior baseline (retry target on failure).
head="$(git_head "$path")"
last="$(state_get "$TARGET" brain-sync lastRunSha)"
# $range = human-readable label (reports/PR/commit msg). $gitrange = a REAL git revision range used for
# EVERY git call below — never feed the label to git: on a fresh/shallow repo that errors silently, the
# numstat returns 0, the substance gate skips, and the baseline advances past the only commit (data loss).
range=""; gitrange=""; diff=""
if [ -n "$last" ] && git -C "$path" cat-file -e "${last}^{commit}" 2>/dev/null; then
  range="${last}..HEAD"; gitrange="$range"
else
  # --verify -q fails cleanly with NO stdout when HEAD~N doesn't exist.
  start="$(git -C "$path" rev-parse --verify -q "HEAD~${REVIEW_LOOKBACK}^{commit}" 2>/dev/null || true)"
  [ -z "$start" ] && start="$(git -C "$path" rev-list --max-parents=0 HEAD 2>/dev/null | tail -1)"   # shallower than lookback → root commit
  if [ -n "$start" ] && [ "$start" != "$head" ]; then
    range="${start}..HEAD"; gitrange="$range"
  else
    # initial / single-commit repo: diff the root commit against the empty tree so diff/numstat/stat all
    # get a VALID range. hash-object -t tree /dev/null yields the empty-tree id (robust to SHA-1/SHA-256).
    range="HEAD (initial commit)"; gitrange="$(git -C "$path" hash-object -t tree /dev/null 2>/dev/null)..HEAD"
  fi
fi
diff="$(git -C "$path" diff "$gitrange" 2>/dev/null)"

# Empty diff ⇒ nothing changed since baseline → advance (truly nothing to record).
# (NEVER use ${diff//…} — O(n²) on large UTF-8 diffs.)
if [ -z "$diff" ]; then
  echo "no source changes since last brain-sync ($range)"
  echo "# brain-sync — no source changes since last sync ($range)" > "$rd/report.md"
  result pass "nothing changed since last sync" 0 "" true "$head" 1; exit 0
fi

# ---- substance gate (cheap, pre-LLM): skip distill+PR for ignorable-only / trivial windows ----
# Count changed lines that are NOT in obviously-noise paths. If below the floor, advance + no PR.
substantive="$(git -C "$path" diff --numstat --no-renames "$gitrange" 2>/dev/null | awk '
  {
    f=$3
    if (f ~ /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|composer\.lock|go\.sum)$/) next
    if (f ~ /(^|\/)(dist|build|out|vendor|node_modules|\.next|coverage)\//) next
    if (f ~ /\.(snap|min\.js|min\.css|map)$/) next
    add=($1=="-")?0:$1; del=($2=="-")?0:$2; tot+=add+del
  }
  END{ print tot+0 }')"
if [ "${substantive:-0}" -lt "${BRAIN_MIN_DIFF_LINES:-8}" ]; then
  echo "diff below substance floor (${substantive} non-noise lines < ${BRAIN_MIN_DIFF_LINES:-8}) — skipping distill ($range)"
  echo "# brain-sync — trivial change ($range), nothing to record (${substantive} substantive lines)" > "$rd/report.md"
  result pass "trivial change — nothing to record" 0 "" true "$head" 1; exit 0
fi

stat="$(git -C "$path" diff --stat "$gitrange" 2>/dev/null | tail -40)"
# Oversized window: DON'T silently truncate into oblivion (the baseline would advance past it).
# Fall back to stat + per-commit log so the window is still RECORDED, then let the model note it.
if [ "${#diff}" -gt "$MAX_BRAIN_DIFF_CHARS" ]; then
  log_lines="$(git -C "$path" log --oneline "$gitrange" 2>/dev/null | head -200)"
  [ -z "$log_lines" ] && log_lines="$(git -C "$path" log --oneline -n 200 HEAD 2>/dev/null)"   # initial-commit gitrange (empty-tree..HEAD) isn't log-able
  diff="[diff exceeded MAX_BRAIN_DIFF_CHARS=${MAX_BRAIN_DIFF_CHARS}; full patch omitted — record file-level changes from the stat and commit log below]

=== COMMITS IN RANGE ===
$log_lines"
fi

# ---- BRAIN repo mutation: serialize across runs (one shared sink), prune stale worktrees ----
# The tick lock does NOT cover manual `sentinel run`; two concurrent runs would race the ONE brain
# repo's ref locks / worktree registry. A dedicated lock around all brain git ops prevents corruption.
if ! lock_acquire brain-repo; then
  echo "another brain-sync holds the brain-repo lock — retry next tick"
  echo "# brain-sync deferred — brain repo busy (another run holds the lock)" > "$rd/report.md"
  result skipped "brain repo busy (locked)" 0 "" true "$head" 0; exit 0   # advance=0: retry this window
fi
brain_locked=1
# Refuse to branch from a brain repo that is mid-operation (a half-rebased base → garbage PR).
if [ -d "$BRAIN_PATH/.git/rebase-merge" ] || [ -d "$BRAIN_PATH/.git/rebase-apply" ] || [ -f "$BRAIN_PATH/.git/MERGE_HEAD" ]; then
  echo "brain repo is mid-rebase/merge — refusing to branch from an inconsistent base"
  echo "# brain-sync skipped — brain repo is mid-rebase/merge (resolve it, then it will retry)" > "$rd/report.md"
  result skipped "brain repo mid-operation" 0 "" true "$head" 0; exit 0
fi
# Assert the brain clone's origin actually points at BRAIN_GITHUB, else push + `gh --repo` disagree.
if [ -n "${BRAIN_GITHUB:-}" ]; then
  origin_url="$(git -C "$BRAIN_PATH" remote get-url origin 2>/dev/null | sed -E 's#^(git@github.com:|https?://github.com/)##; s#\.git$##')"
  if [ -n "$origin_url" ] && [ "$origin_url" != "$BRAIN_GITHUB" ]; then
    echo "brain origin ($origin_url) != BRAIN_GITHUB ($BRAIN_GITHUB) — refusing to push to the wrong repo"
    echo "# brain-sync skipped — brain clone origin does not match BRAIN_GITHUB" > "$rd/report.md"
    result error "brain origin != BRAIN_GITHUB" 0 "" false "$head" 0; exit 0
  fi
fi
# Prune worktree-registry entries leaked by crashed prior runs (trap couldn't fire on kill -9).
git -C "$BRAIN_PATH" worktree prune >>"$rd/run.log" 2>&1 || true

git -C "$BRAIN_PATH" fetch --quiet origin "$BRAIN_BASE" >>"$rd/run.log" 2>&1 || echo "warn: brain fetch failed (using local $BRAIN_BASE)"
# Branch from the freshest base: origin/$BRAIN_BASE if present, else local $BRAIN_BASE.
base_ref="origin/$BRAIN_BASE"; git -C "$BRAIN_PATH" rev-parse --verify -q "$base_ref^{commit}" >/dev/null 2>&1 || base_ref="$BRAIN_BASE"
git -C "$BRAIN_PATH" worktree add -B "$branch" "$wt" "$base_ref" >>"$rd/run.log" 2>&1 || {
  echo "brain worktree add failed"; echo "# brain-sync failed — could not create brain worktree" > "$rd/report.md"
  result error "brain worktree add failed" 0 "" false "$head" 0; exit 0   # advance=0: retry this window
}

# Reject a symlinked target file or symlinked parent dir (TOCTOU: edit-one-path could write through it).
mkdir -p "$wt/30-engineering/repos"
if [ -L "$wt/$BRAIN_FILE" ] || [ -L "$wt/30-engineering/repos" ] || [ -L "$wt/30-engineering" ]; then
  echo "ABORT: $BRAIN_FILE (or a parent) is a symlink in the brain repo"
  echo "# brain-sync ABORTED — target path is a symlink (refusing to write through it)" > "$rd/report.md"
  result fail "aborted: brain target is a symlink" 0 "" false "$head" 0; exit 0
fi

# Current content of the target brain file (empty string if it doesn't exist yet → model creates it).
current=""; [ -f "$wt/$BRAIN_FILE" ] && current="$(cat "$wt/$BRAIN_FILE")"
today="$(date +%Y-%m-%d)"
head7="${head:0:7}"

# ---- prompt: APPEND-ONLY dated bullets (idempotent), four categories, house format ----
read -r -d '' rules <<'EOF'
You maintain a SHARED, PRIVATE team knowledge base ("the brain"). Update EXACTLY ONE file, given below,
so it captures only IMPORTANT, factual, team-relevant engineering changes from the source repo's recent diff.

Edit ONLY this one file (the tool is already scoped to it). Do NOT create, rename, or touch any other file.
You have NO shell/Bash access — only edit this file's text.

Capture changes that fall into these FOUR categories (use these as the H2 sections, in this order):
  ## Skills & conventions      — new/changed coding conventions, lint/test/CI commands, branch & PR norms, naming.
  ## Architecture & decisions  — modules/services and how they fit; design decisions and WHY (ADR-style).
  ## API / interface changes   — public HTTP/MCP/CLI/SDK surface; breaking or additive changes.
  ## Dependencies & infra      — notable deps, runtime/services, deploy targets, env-var NAMES only, migrations.

APPEND-ONLY LOG FORMAT (this is what keeps the file convergent — follow it EXACTLY):
- Each H2 section is a list of dated bullets, NEWEST AT THE TOP. Bullet form:
    - <TODAY> <SHA7> — <one concrete fact> (path/to/file)
  where <SHA7> is the source HEAD short SHA given to you below (your idempotency key for THIS run).
- ONLY add bullets for the change described in THIS diff/range. Prepend them at the TOP of the matching section.
- NEVER edit, re-word, re-order, or delete an existing bullet whose SHA7 differs from THIS run's SHA7.
  The ONLY existing bullet you may revise is one YOU added in a prior run that is now factually wrong.
- If you have already recorded this exact SHA7 (you see a bullet with it), make NO change at all.
- Soft cap: keep each section to ~40 of the most recent bullets. When a section exceeds that, MOVE the
  oldest bullets VERBATIM into a `<details><summary>Archive</summary>` … `</details>` block at the bottom
  of that section. Do NOT delete or re-summarize archived bullets.

House file format (match EXACTLY — it mirrors 30-engineering/_template.md and the brain's product briefs):
- H1 = the repo name.
- Immediately under H1, a plain-text block (NOT yaml frontmatter):
    last-updated: <TODAY>
    status: Active
- Then bold inline fields:  **Repo:** Simbastack-hq/<repo>  ,  a one-line **Stack:** if known,  and
  **Product:** ../../10-products/<name>.md  ONLY if such a product brief plausibly exists (else omit the line).
- Then the four H2 sections above.
- End the file with this exact footer — a line `---` then the italic line:
    *Public-safe only. No pricing internals, net rates, PII, or secrets (see ../../CLAUDE.md). Engineering log — kept fresh by Sentinel's `brain-sync`; safe to hand-edit.*
- Mark unknowns inline as `TODO:` — NEVER invent a fact. Every non-obvious claim should cite an in-repo path.
- Set `last-updated:` to TODAY **only if** you actually add or change a factual bullet. If you make no
  factual change, leave the file byte-for-byte unchanged — do NOT bump the date.

HARD PUBLIC-SAFE RULES (this repo is read by the whole team — violating these is worse than writing nothing):
- NEVER write secrets, tokens, API keys, passwords, .env VALUES (env NAMES are fine), connection strings.
- NEVER write pricing internals, net rates, margins, financials, or customer/guest PII.
- API SHAPES yes; secrets no. Env NAMES yes; env VALUES never.
- House voice: direct, concrete, dense, skimmable. No marketing fluff, no AI tells.

If NOTHING in the diff is important, team-relevant, AND public-safe, make NO edit at all (leave the file byte-for-byte unchanged).
EOF

prompt="$rules

TODAY: $today
SOURCE REPO: $TARGET   (GitHub: ${TARGET_GITHUB:-unknown})
THIS RUN'S SHA7 (idempotency key for new bullets): $head7
DIFF RANGE: $range

=== CURRENT CONTENT OF $BRAIN_FILE (empty means the file does not exist yet — create it in house format) ===
$current

=== CHANGED FILES (source) ===
$stat

=== SOURCE DIFF ===
$diff
"

# ---- run claude in the BRAIN worktree, scoped to the single brain file, NO Bash ----
# --allowedTools takes ONE comma/space-separated list (verified via `claude --help`: <tools...>).
# --disallowedTools "Bash" is the load-bearing restriction: under acceptEdits in a worktree of the
# SHARED brain repo, an unrestricted Bash tool could exfiltrate the diff or push elsewhere. The PATH
# + CONTENT guards remain the real enforcement; tool scoping is defense-in-depth.
( cd "$wt" && run_to "$CMD_TIMEOUT" claude -p "$prompt" \
    --permission-mode "$CLAUDE_PERMISSION_MODE" \
    --allowedTools "Edit,Write,Read" \
    --disallowedTools "Bash,WebFetch,WebSearch" \
    --output-format json ) > "$rd/artifacts/claude.json" 2>>"$rd/run.log" || echo "warn: claude nonzero exit"
cost="$(jq -r '.total_cost_usd // .cost_usd // empty' "$rd/artifacts/claude.json" 2>/dev/null)"

# ---- detect what changed in the BRAIN worktree ----
git -C "$wt" add -A 2>/dev/null
changed="$(git -C "$wt" diff --cached --name-only 2>/dev/null)"

if [ -z "$changed" ]; then
  echo "no brain change — nothing important to record"
  { echo "# brain-sync — $TARGET"; echo; echo "Reviewed source range \`$range\` (HEAD \`$head7\`). Nothing important/public-safe to record in the brain.${cost:+ (cost \$$cost)}"; } > "$rd/report.md"
  result pass "nothing important to record" 0 "$cost" false "$head" 1; exit 0   # advance=1: genuinely nothing
fi

# ---- PATH GUARD (stricter than docs-sync): the ONLY changed path must be exactly $BRAIN_FILE. ----
extra=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ "$f" = "$BRAIN_FILE" ] && continue
  extra="$extra$f"$'\n'
done <<< "$changed"
if [ -n "$(printf '%s' "$extra" | tr -d '[:space:]')" ]; then
  echo "ABORT: model touched paths other than $BRAIN_FILE:"; echo "$extra"
  git -C "$wt" reset --hard HEAD >>"$rd/run.log" 2>&1 || true
  git -C "$wt" clean -fd >>"$rd/run.log" 2>&1 || true
  { echo "# brain-sync ABORTED — $TARGET"; echo
    echo "The model changed paths other than the single allowed brain file \`$BRAIN_FILE\`, so **all changes were discarded** (safety guard). Nothing was committed to the brain. The source window will be retried next run."; echo
    echo "Rejected paths:"; echo '```'; echo "$extra"; echo '```'; } > "$rd/report.md"
  result fail "aborted: model touched non-target paths (discarded)" 0 "$cost" false "$head" 0; exit 0   # advance=0
fi

# Exactly $BRAIN_FILE changed. Stage the patch for the CONTENT guard.
git -C "$wt" diff --cached > "$rd/artifacts/brain.patch" 2>/dev/null

# ---- CONTENT GUARD: scan the staged brain diff for secrets BEFORE anything leaves the machine. ----
# The PATH guard controls WHICH file changes; this controls WHAT content reaches a SHARED repo + PR body.
# A model can copy a secret out of the source diff into the brain file — the prompt is a request, not
# enforcement. On any hit: discard everything, fail, hold the baseline (retry).
secret_hit="$(grep -aEi \
  -e 'AKIA[0-9A-Z]{16}' \
  -e '-----BEGIN[A-Z ]*PRIVATE KEY-----' \
  -e 'gh[pousr]_[A-Za-z0-9]{20,}' \
  -e 'xox[baprs]-[A-Za-z0-9-]{10,}' \
  -e 'sk-[A-Za-z0-9]{20,}' \
  -e '(password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)["'"'"' ]*[:=]["'"'"' ]*[^[:space:]"'"'"']{6,}' \
  -e '(postgres|postgresql|mysql|mongodb(\+srv)?|redis|amqp)://[^[:space:]/]+:[^[:space:]/@]+@' \
  -e 'Authorization:[[:space:]]*(Bearer|Basic)[[:space:]]+[A-Za-z0-9._-]{10,}' \
  "$rd/artifacts/brain.patch" 2>/dev/null | head -5 || true)"
if [ -n "$secret_hit" ]; then
  echo "ABORT: secret-like content detected in the proposed brain diff — discarding."
  git -C "$wt" reset --hard HEAD >>"$rd/run.log" 2>&1 || true
  git -C "$wt" clean -fd >>"$rd/run.log" 2>&1 || true
  : > "$rd/artifacts/brain.patch"   # do NOT leave the secret-bearing patch on disk
  { echo "# brain-sync ABORTED — $TARGET"; echo
    echo "The proposed brain update contained content matching secret patterns, so **all changes were discarded** and the patch was wiped. Nothing was committed or pushed. The source window will be retried (fix the source or refine the prompt)."; } > "$rd/report.md"
  result fail "aborted: secret-like content in brain diff (discarded)" 0 "$cost" false "$head" 0; exit 0   # advance=0
fi

# ---- commit + push + PR (gated by ENABLE_BRAIN_PR; never auto-merges) ----
pr_url=""; pushed=0
if [ "${ENABLE_BRAIN_PR:-0}" = 1 ] && [ -n "${BRAIN_GITHUB:-}" ] && have gh; then
  ( cd "$wt" && git -c user.email=sentinel@local -c user.name=sentinel \
      commit -q -m "brain: record engineering changes from $TARGET ($range) [sentinel $RUN_ID]" ) >>"$rd/run.log" 2>&1
  if ( cd "$wt" && git push -u origin "$branch" --quiet ) >>"$rd/run.log" 2>&1; then
    pushed=1
    pr_url="$( cd "$wt" && gh pr create --repo "$BRAIN_GITHUB" --base "$BRAIN_BASE" --head "$branch" \
      --title "brain: $TARGET engineering update ($today)" \
      --body "Automated knowledge-base update by Sentinel run \`$RUN_ID\`.

- Source repo: **$TARGET** (${TARGET_GITHUB:-n/a})
- Source range: \`$range\` (HEAD \`$head7\`)
- Brain file: \`$BRAIN_FILE\` (single-file path guard + secret-content guard passed)

Public-safe, human review + merge required. **Never auto-merged.**" 2>>"$rd/run.log" )" || echo "warn: gh pr create failed"
  else echo "warn: brain push failed (local patch saved to artifacts/brain.patch)"; fi
fi

# If we pushed a branch but failed to open a PR, delete the orphaned remote branch (no PR backs it).
if [ "$pushed" = 1 ] && [ -z "$pr_url" ]; then
  ( cd "$wt" && git push origin --delete "$branch" --quiet ) >>"$rd/run.log" 2>&1 || echo "warn: could not delete orphan remote branch $branch"
fi

# ---- report.md (human) + result.json ----
{
  echo "# brain-sync — $TARGET"
  echo; echo "- brain file: \`$BRAIN_FILE\`  •  source range: \`$range\`  •  source HEAD: \`$head7\`${cost:+  •  cost: \$$cost}"
  if [ -n "$pr_url" ]; then echo "- PR: $pr_url"
  else echo "- mode: local patch → \`$rd/artifacts/brain.patch\` (apply in brain repo: \`git -C \$BRAIN_PATH apply <patch>\`)"; fi
  echo; echo "## Source changes considered"; echo '```'; echo "$stat"; echo '```'
  echo; echo "## Proposed brain diff"; echo '```diff'; head -c 20000 "$rd/artifacts/brain.patch"; echo; echo '```'
} > "$rd/report.md"

# Verdict + advance:
#  - PR opened            → issues (⚠️ human action awaited), advance=1
#  - dry-run patch saved   → pass (✅ quiet; ENABLE_BRAIN_PR=0 is intentional, don't spam ntfy), advance=1
#  - push/PR-create fail   → error (❌), advance=0 (retry this window next tick)
if [ -n "$pr_url" ]; then
  result issues "brain PR opened: $pr_url" 1 "$cost" false "$head" 1
elif [ "${ENABLE_BRAIN_PR:-0}" = 1 ]; then
  # PR was requested but push or pr-create failed → real failure, hold baseline, keep patch for retry/manual apply.
  result error "brain push/PR failed — patch saved, will retry" 1 "$cost" false "$head" 0
else
  # Dry-run mode: local patch only, by design. Quiet pass, advance the baseline.
  result pass "brain update proposed for $BRAIN_FILE (dry-run patch) — review locally" 1 "$cost" false "$head" 1
fi
echo "done: brain update for $BRAIN_FILE${pr_url:+ → $pr_url}"
