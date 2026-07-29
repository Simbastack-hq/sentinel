#!/usr/bin/env bash
# review agent — read-only code review of the diff since the last review.
# Inputs (env): RUN_DIR TARGET TARGET_PATH TARGET_BASE TARGET_GITHUB AI_ALLOWED. Outputs: report.md, result.json.
. "$SENTINEL_HOME/lib/common.sh"
path="$TARGET_PATH"; rd="$RUN_DIR"

result(){ # verdict summary findings cost skipped sha
  jq -n --arg v "$1" --arg s "$2" --argjson f "${3:-0}" --arg c "${4:-}" --argjson sk "${5:-false}" --arg sha "${6:-}" \
    '{verdict:$v,summary:$s,findings:$f,cost:$c,skipped:$sk,sha:$sha}' > "$rd/result.json"
}

[ -d "$path/.git" ] || { echo "not a git repo: $path"; echo "# review skipped — not a git repo" > "$rd/report.md"; result skipped "not a git repo" 0 "" true ""; exit 0; }
if [ "$AI_ALLOWED" != "true" ]; then
  echo "ai_allowed=false → not sending code to a model"; echo "# review skipped — ai_allowed is false" > "$rd/report.md"; result skipped "ai_allowed=false" 0 "" true ""; exit 0
fi

head="$(git_head "$path")"
last="$(state_get "$TARGET" review lastRunSha)"
range=""; diff=""
if [ -n "$last" ] && git -C "$path" cat-file -e "${last}^{commit}" 2>/dev/null; then
  range="${last}..HEAD"; diff="$(git -C "$path" diff "$range" 2>/dev/null)"
else
  # --verify -q fails cleanly with NO stdout when HEAD~N doesn't exist (plain rev-parse echoes the unresolved arg).
  start="$(git -C "$path" rev-parse --verify -q "HEAD~${REVIEW_LOOKBACK}^{commit}" 2>/dev/null || true)"
  [ -z "$start" ] && start="$(git -C "$path" rev-list --max-parents=0 HEAD 2>/dev/null | tail -1)"   # shallower than lookback → root commit
  if [ -n "$start" ] && [ "$start" != "$head" ]; then range="${start}..HEAD"; diff="$(git -C "$path" diff "$range" 2>/dev/null)"; else range="HEAD (initial commit)"; diff="$(git -C "$path" show HEAD 2>/dev/null)"; fi
fi

if [ -z "$diff" ]; then   # git diff is empty-string when there are no changes (NEVER use ${diff//…} — O(n²) on large UTF-8 diffs)
  echo "no changes since last review ($range)"; echo "# review — no changes since last review ($range)" > "$rd/report.md"; result pass "no changes since last review" 0 "" true "$head"; exit 0
fi

stat="$(git -C "$path" diff --stat "$range" 2>/dev/null | tail -40)"
# Truncate oversized diffs.
if [ "${#diff}" -gt "$MAX_REVIEW_DIFF_CHARS" ]; then diff="${diff:0:$MAX_REVIEW_DIFF_CHARS}"$'\n\n...[diff truncated]'; fi

read -r -d '' prompt <<EOF
You are a senior engineer doing a focused code review of recent changes in the repo "$TARGET" (range $range).
Identify real correctness bugs, security issues, data-loss risks, and clearly-wrong logic. Be concise and specific, citing file:line. Skip pure style/formatting nits. If nothing is notable, say so plainly.
End your reply with EXACTLY these two lines:
SENTINEL_VERDICT: pass
SENTINEL_FINDINGS: 0
(use "issues" and the real count if you found problems.)

CHANGED FILES:
$stat

DIFF:
$diff
EOF

out="$rd/artifacts/review.out"; cost=""
echo "engine=$REVIEW_ENGINE range=$range diff_chars=${#diff}"
case "$REVIEW_ENGINE" in
  codex)
    ( cd "$path" && run_to "$CMD_TIMEOUT" codex exec -s read-only -m "$CODEX_MODEL" \
        -c model_reasoning_effort="$CODEX_REASONING" "$prompt" ) > "$out" 2>>"$rd/run.log" || echo "warn: codex nonzero exit" ;;
  claude)
    ( cd "$path" && run_to "$CMD_TIMEOUT" claude -p "$prompt" --permission-mode plan --output-format json ) > "$rd/artifacts/claude.json" 2>>"$rd/run.log" || echo "warn: claude nonzero exit"
    jq -r '.result // empty' "$rd/artifacts/claude.json" > "$out" 2>/dev/null
    cost="$(jq -r '.total_cost_usd // .cost_usd // empty' "$rd/artifacts/claude.json" 2>/dev/null)" ;;
  pi)
    # Tight bound: a stalled Mimo call must never block the single-flight scheduler.
    run_to "$REVIEW_TIMEOUT" node "$SENTINEL_HOME/bin/pi-ask.js" --provider "$QA_PROVIDER" --model "$QA_MODEL" --thinking "$REVIEW_THINKING" --timeout "$(( REVIEW_TIMEOUT > 30 ? REVIEW_TIMEOUT - 15 : REVIEW_TIMEOUT ))" "$prompt" > "$out" 2>"$rd/artifacts/pi.err" || echo "warn: pi timeout/nonzero exit"
    cost="$(sed -n 's/^COST=//p' "$rd/artifacts/pi.err" | tail -1)" ;;
  *) echo "unknown REVIEW_ENGINE=$REVIEW_ENGINE"; result error "unknown REVIEW_ENGINE" 0 "" false "$head"; exit 0 ;;
esac

[ -s "$out" ] || { echo "empty review output"; echo "# review — engine produced no output (see run.log)" > "$rd/report.md"; result error "empty engine output" 0 "$cost" false "$head"; exit 0; }

verdict="$(grep -iE '^SENTINEL_VERDICT:' "$out" | tail -1 | sed -E 's/.*:[[:space:]]*//' | tr -d '[:space:]')"; [ -n "$verdict" ] || verdict=issues
findings="$(grep -iE '^SENTINEL_FINDINGS:' "$out" | tail -1 | grep -oE '[0-9]+' | tail -1)"; [ -n "$findings" ] || findings=0
case "$verdict" in pass) v=pass;; *) v=issues;; esac

{
  echo "# Code review — $TARGET"
  echo; echo "- range: \`$range\`  •  engine: $REVIEW_ENGINE  •  HEAD: \`${head:0:7}\`${cost:+  •  cost: \$$cost}"
  echo "- verdict: **$v**  •  findings: **$findings**"
  echo; echo '```'; echo "$stat"; echo '```'; echo
  sed -E '/^SENTINEL_(VERDICT|FINDINGS):/d' "$out"
} > "$rd/report.md"

# Optional: post to an open PR for HEAD's branch.
if [ "$ENABLE_REVIEW_PR_COMMENT" = 1 ] && [ -n "$TARGET_GITHUB" ] && have gh; then
  br="$(git -C "$path" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  pr="$(cd "$path" && gh pr list --head "$br" --json url -q '.[0].url' 2>/dev/null)"
  [ -n "$pr" ] && ( cd "$path" && gh pr comment "$pr" --body-file "$rd/report.md" ) >>"$rd/run.log" 2>&1 && echo "posted review to $pr"
fi

result "$v" "review of $range: $findings finding(s)" "$findings" "$cost" false "$head"
echo "done: $v ($findings findings)"
