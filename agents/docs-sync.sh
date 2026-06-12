#!/usr/bin/env bash
# docs-sync agent — keep Markdown docs in sync with code, in an ISOLATED worktree,
# hard-guarded to docs-only. Never auto-merges, never touches the real working tree.
# Inputs (env): RUN_DIR TARGET TARGET_PATH TARGET_BASE TARGET_GITHUB AI_ALLOWED. Outputs: report.md, result.json.
. "$SENTINEL_HOME/lib/common.sh"
path="$TARGET_PATH"; rd="$RUN_DIR"
WT_BASE="$VAR/worktrees"; mkdir -p "$WT_BASE"
wt="$WT_BASE/$RUN_ID"; branch="sentinel/docs/$RUN_ID"

result(){ jq -n --arg v "$1" --arg s "$2" --argjson f "${3:-0}" --arg c "${4:-}" --argjson sk "${5:-false}" --arg sha "${6:-}" \
  '{verdict:$v,summary:$s,findings:$f,cost:$c,skipped:$sk,sha:$sha}' > "$rd/result.json"; }
cleanup(){ git -C "$path" worktree remove --force "$wt" 2>/dev/null || rm -rf "$wt"; git -C "$path" branch -D "$branch" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

[ -d "$path/.git" ] || { echo "# docs-sync skipped — not a git repo" > "$rd/report.md"; result skipped "not a git repo" 0 "" true ""; exit 0; }
if [ "$AI_ALLOWED" != "true" ]; then echo "# docs-sync skipped — ai_allowed is false" > "$rd/report.md"; result skipped "ai_allowed=false" 0 "" true ""; exit 0; fi
have claude || { echo "# docs-sync skipped — claude CLI missing" > "$rd/report.md"; result skipped "claude missing" 0 "" true ""; exit 0; }

head="$(git_head "$path")"
git -C "$path" worktree add -B "$branch" "$wt" HEAD >>"$rd/run.log" 2>&1 || { echo "worktree add failed"; echo "# docs-sync failed — worktree" > "$rd/report.md"; result error "worktree add failed" 0 "" false "$head"; exit 0; }

read -r -d '' prompt <<'EOF'
You are a documentation maintainer. Update ONLY Markdown documentation in this repository so it accurately reflects the CURRENT code: fix outdated commands, file paths, feature descriptions, setup steps, and obvious gaps. Allowed to edit: README*, CHANGELOG*, any *.md / *.mdx, and anything under docs/. You MUST NOT modify code, config, tests, CI workflows, package manifests, or lockfiles. If the docs already match the code, make NO changes at all. Keep every edit surgical and factual — do not invent features.
EOF

( cd "$wt" && run_to "$CMD_TIMEOUT" claude -p "$prompt" --permission-mode "$CLAUDE_PERMISSION_MODE" --output-format json ) > "$rd/artifacts/claude.json" 2>>"$rd/run.log" || echo "warn: claude nonzero exit"
cost="$(jq -r '.total_cost_usd // .cost_usd // empty' "$rd/artifacts/claude.json" 2>/dev/null)"

git -C "$wt" add -A 2>/dev/null
changed="$(git -C "$wt" diff --cached --name-only 2>/dev/null)"
if [ -z "$changed" ]; then
  echo "no doc changes — docs already in sync"
  { echo "# docs-sync — $TARGET"; echo; echo "Docs already in sync with the code at \`${head:0:7}\`. No changes proposed.${cost:+ (cost \$$cost)}"; } > "$rd/report.md"
  result pass "docs already in sync" 0 "$cost" false "$head"; exit 0
fi

# GUARD: every changed path must be documentation, or ALL changes are discarded.
# (1) reject known code/config extensions FIRST — so even a code file under docs/ is caught;
# (2) then require a strict doc allow-list with anchored basenames (no prefix matches).
nondoc=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  base="${f##*/}"
  case "$base" in
    *.js|*.jsx|*.ts|*.tsx|*.mjs|*.cjs|*.py|*.go|*.rb|*.rs|*.java|*.kt|*.c|*.h|*.hpp|*.cpp|*.cc|*.cs|*.php|*.swift|*.sh|*.bash|*.zsh|*.pl|*.lua|*.sql|*.r|*.scala|*.dart \
    |*.yml|*.yaml|*.toml|*.ini|*.cfg|*.conf|*.json|*.json5|*.lock|*.env|*.tf|*.gradle|*.xml|*.plist|Dockerfile|Makefile|*.mk)
      nondoc="$nondoc$f"$'\n'; continue ;;
  esac
  case "$f" in
    *.md|*.mdx) ;;                                   # markdown anywhere
    docs/*|*/docs/*) ;;                               # under a docs/ dir (already passed the code denylist)
    *) case "$base" in
         README|README.*|CHANGELOG|CHANGELOG.*|CONTRIBUTING|CONTRIBUTING.*|LICENSE|LICENSE.*|AUTHORS|NOTICE) ;;  # exact, anchored doc basenames
         *) nondoc="$nondoc$f"$'\n' ;;
       esac ;;
  esac
done <<< "$changed"
if [ -n "$(printf '%s' "$nondoc" | tr -d '[:space:]')" ]; then
  echo "ABORT: agent modified non-doc files:"; echo "$nondoc"
  git -C "$wt" reset --hard HEAD >>"$rd/run.log" 2>&1 || true
  { echo "# docs-sync ABORTED — $TARGET"; echo; echo "The agent tried to edit non-documentation files, so **all changes were discarded** (safety guard). Nothing was written to your repo."; echo; echo "Rejected paths:"; echo '```'; echo "$nondoc"; echo '```'; } > "$rd/report.md"
  result fail "aborted: agent touched non-doc files (discarded)" 0 "$cost" false "$head"; exit 0
fi

nfiles="$(echo "$changed" | grep -c .)"
git -C "$wt" diff --cached > "$rd/artifacts/docs.patch" 2>/dev/null

pr_url=""
if [ "$ENABLE_DOCS_PR" = 1 ] && [ -n "$TARGET_GITHUB" ] && have gh; then
  ( cd "$wt" && git -c user.email=sentinel@local -c user.name=sentinel commit -q -m "docs: sync with code (sentinel $RUN_ID)" ) >>"$rd/run.log" 2>&1
  if ( cd "$wt" && git push -u origin "$branch" --quiet ) >>"$rd/run.log" 2>&1; then
    pr_url="$( cd "$wt" && gh pr create --base "$TARGET_BASE" --head "$branch" --title "docs: sync with code" \
      --body "Automated docs-only update by Sentinel run \`$RUN_ID\`. Docs-only guard passed. Human review + merge required." 2>>"$rd/run.log" )" || echo "warn: gh pr create failed"
  else echo "warn: push failed (local patch saved)"; fi
fi

{
  echo "# docs-sync — $TARGET"
  echo; echo "- $nfiles doc file(s) updated vs \`${head:0:7}\`${cost:+  •  cost: \$$cost}"
  [ -n "$pr_url" ] && echo "- PR: $pr_url" || echo "- mode: local patch → \`$rd/artifacts/docs.patch\` (apply with: \`git -C $path apply <patch>\`)"
  echo; echo "## Files"; echo '```'; echo "$changed"; echo '```'
  echo; echo "## Proposed diff"; echo '```diff'; head -c 20000 "$rd/artifacts/docs.patch"; echo; echo '```'
} > "$rd/report.md"

if [ -n "$pr_url" ]; then result issues "docs PR opened: $pr_url ($nfiles files)" "$nfiles" "$cost" false "$head"
else result issues "$nfiles doc file(s) proposed — review patch" "$nfiles" "$cost" false "$head"; fi
echo "done: $nfiles doc file(s) proposed${pr_url:+ → $pr_url}"
