#!/usr/bin/env bash
# pr-qa agent — on-demand QA for pull requests, triggered by a "/qa <what to test>" PR comment.
#
# Poll model (no webhooks, no GitHub App): each tick, scan the target repo's open PRs for a new
# command comment from an allowed author, resolve that PR's preview deployment URL, run the
# existing qa engine against it with the comment text as the goal, and post ONE result comment
# back on the PR. The comment gets an "eyes" reaction the moment it's picked up.
#
# Reuses the target's agents.qa.app config wholesale (engine, model, auth capture, web3 shim,
# storage seeding). Hard safety overrides in this context, enforced in agents/qa.sh via PRQA=1:
#   - always an UNFUNDED fresh burner (funded keys and allow_funded are ignored — PR code is
#     arbitrary code; a funded session must never meet it)
#   - GitHub issue auto-filing is OFF (the report goes to the PR thread instead)
#
# Inputs (env): RUN_DIR TARGET TARGET_PATH AI_ALLOWED.
. "$SENTINEL_HOME/lib/common.sh"
rd="$RUN_DIR"; head="$(git_head "$TARGET_PATH")"

result(){ jq -n --arg v "$1" --arg s "$2" --argjson f "${3:-0}" --arg c "${4:-}" --argjson sk "${5:-false}" --arg sha "${6:-}" \
  '{verdict:$v,summary:$s,findings:$f,cost:$c,skipped:$sk,sha:$sha}' > "$rd/result.json"; }

if [ "$AI_ALLOWED" != "true" ]; then echo "# pr-qa skipped — ai_allowed is false" > "$rd/report.md"; result skipped "ai_allowed=false" 0 "" true "$head"; exit 0; fi

pq(){ jq -r --arg t "$TARGET" ".targets[\$t].agents[\"pr-qa\"]$1" "$TARGETS_JSON" 2>/dev/null; }
repo="$(pq '.repo // empty')"; [ -n "$repo" ] || repo="$(t_field "$TARGET" github)"
command_word="$(pq '.command // "/qa"')"
allowed="$(pq '.allowed_associations // ["OWNER","MEMBER","COLLABORATOR"] | join(" ")')"
max_prs="$(pq '.max_prs_per_tick // 1')"
max_daily="$(pq '.max_runs_per_pr_per_day // 4')"
url_template="$(pq '.preview_url_template // empty')"
case "$max_prs" in ''|*[!0-9]*) max_prs=1;; esac
case "$max_daily" in ''|*[!0-9]*) max_daily=4;; esac

[ -n "$repo" ] || { echo "# pr-qa — no repo configured" > "$rd/report.md"; result skipped "no repo (set agents.pr-qa.repo or target.github)" 0 "" true "$head"; exit 0; }
gh auth status >/dev/null 2>&1 || { echo "# pr-qa — gh not authenticated" > "$rd/report.md"; result error "gh not authenticated" 0 "" false "$head"; exit 0; }

today="$(date +%F)"
processed=0; total_bugs=0; notes=""

# Slugify a branch name the way Vercel does for {branch} in preview_url_template (lowercase,
# non-alphanumerics collapsed to '-'). Best-effort — deployment-status lookup is the reliable path.
slugify(){ printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\{1,\}/-/g; s/^-//; s/-$//'; }

# Resolve the PR's preview URL: prefer the newest successful deployment status for the head SHA
# (Vercel/Netlify/Cloudflare all publish environment_url there), else the operator's template.
resolve_preview(){ # sha branch -> url or empty
  local sha="$1" branch="$2" url=""
  local dep_ids; dep_ids="$(gh api "repos/$repo/deployments?sha=$sha&per_page=5" --jq '.[].id' 2>/dev/null)"
  local id
  for id in $dep_ids; do
    url="$(gh api "repos/$repo/deployments/$id/statuses?per_page=10" \
      --jq '[.[] | select(.state=="success") | .environment_url // empty] | map(select(. != "")) | first // empty' 2>/dev/null)"
    [ -n "$url" ] && { printf '%s' "$url"; return 0; }
  done
  if [ -n "$url_template" ]; then
    printf '%s' "${url_template//\{branch\}/$(slugify "$branch")}"
    return 0
  fi
  return 1
}

prs="$(gh api "repos/$repo/pulls?state=open&per_page=30" \
  --jq '[.[] | {n: .number, branch: .head.ref, sha: .head.sha}]' 2>>"$rd/run.log")" || prs="[]"
pr_count="$(jq 'length' <<<"$prs")"
echo "pr-qa: $repo — $pr_count open PR(s), command '$command_word'"

i=0
while [ "$i" -lt "$pr_count" ] && [ "$processed" -lt "$max_prs" ]; do
  n="$(jq -r ".[$i].n" <<<"$prs")"; branch="$(jq -r ".[$i].branch" <<<"$prs")"; sha="$(jq -r ".[$i].sha" <<<"$prs")"
  i=$((i+1))

  # Newest qualifying command comment: allowed author association, body starts with the command
  # word, id newer than the last one we processed for this PR.
  last_id="$(state_get "$TARGET" pr-qa "pr${n}_last_id")"; : "${last_id:=0}"
  cmt="$(gh api "repos/$repo/issues/$n/comments?per_page=100" --jq \
    "[.[] | select(.body | startswith(\"$command_word\"))
         | select([.author_association] | inside([$(printf '"%s",' $allowed | sed 's/,$//')]))
         | {id, body, user: .user.login}] | sort_by(.id) | last // empty" 2>>"$rd/run.log")"
  [ -n "$cmt" ] || continue
  cid="$(jq -r '.id' <<<"$cmt")"
  [ "$cid" -gt "$last_id" ] 2>/dev/null || continue

  # Per-PR daily cap — fail closed and loud on the PR so the requester isn't left waiting.
  ran_today="$(state_get "$TARGET" pr-qa "pr${n}_runs_$today")"; : "${ran_today:=0}"
  if [ "$ran_today" -ge "$max_daily" ]; then
    state_set "$TARGET" pr-qa "pr${n}_last_id" "$cid"
    gh pr comment "$n" --repo "$repo" --body "**sentinel-qa:** daily run cap ($max_daily) reached for this PR — try again tomorrow or bump \`max_runs_per_pr_per_day\`." >/dev/null 2>&1 || true
    notes="$notes
- PR #$n: daily cap reached"
    continue
  fi

  goal="$(jq -r '.body' <<<"$cmt" | sed "s|^$command_word||" | sed 's/^[[:space:]]*//')"
  [ -n "$goal" ] || goal="$(t_app "$TARGET" goal)"
  requester="$(jq -r '.user' <<<"$cmt")"

  preview="$(resolve_preview "$sha" "$branch")" || preview=""
  if [ -z "$preview" ]; then
    state_set "$TARGET" pr-qa "pr${n}_last_id" "$cid"
    gh pr comment "$n" --repo "$repo" --body "**sentinel-qa:** couldn't resolve a preview deployment for \`$sha\` (no successful deployment status, no \`preview_url_template\`). Is the preview build green?" >/dev/null 2>&1 || true
    notes="$notes
- PR #$n: no preview URL"
    continue
  fi
  if ! curl -fsS --max-time 15 -o /dev/null "$preview"; then
    state_set "$TARGET" pr-qa "pr${n}_last_id" "$cid"
    gh pr comment "$n" --repo "$repo" --body "**sentinel-qa:** preview \`$preview\` isn't answering — skipping this run. Re-comment \`$command_word\` once the deployment is up." >/dev/null 2>&1 || true
    notes="$notes
- PR #$n: preview unreachable"
    continue
  fi

  # Ack the pickup so the requester knows it's running.
  gh api -X POST "repos/$repo/issues/comments/$cid/reactions" -f content=eyes >/dev/null 2>&1 || true
  echo "pr-qa: PR #$n by @$requester — driving $preview"

  prd="$rd/pr-$n"; mkdir -p "$prd/artifacts"; : > "$prd/run.log"
  # Same target, same qa app config — only the origin, goal, and safety context differ.
  PRQA=1 PRQA_BASE_URL="$preview" PRQA_GOAL="$goal" \
  RUN_ID="${RUN_ID:-pr$n}" RUN_DIR="$prd" TARGET="$TARGET" TARGET_PATH="$TARGET_PATH" AI_ALLOWED="$AI_ALLOWED" SENTINEL_HOME="$SENTINEL_HOME" \
    bash "$SENTINEL_HOME/agents/qa.sh" >>"$prd/run.log" 2>&1
  rc=$?

  verdict="error"; bugs=0; summary="qa run produced no result (rc=$rc)"
  if [ -f "$prd/result.json" ]; then
    verdict="$(jq -r '.verdict // "error"' "$prd/result.json")"
    bugs="$(jq -r '.findings // 0' "$prd/result.json")"
    summary="$(jq -r '.summary // ""' "$prd/result.json")"
  fi
  total_bugs=$((total_bugs + bugs))

  rep="$prd/artifacts/qa/report.json"
  body="**sentinel-qa** drove this PR's preview (\`$preview\`) — verdict: **$verdict**

**Goal:** $goal
"
  if [ -f "$rep" ] && [ "$bugs" -gt 0 ] 2>/dev/null; then
    body="$body
**Findings:**
$(jq -r '.bugs[] | "- **[\(.severity)]** \(.desc)"' "$rep" 2>/dev/null | head -10)
"
  fi
  if [ -f "$rep" ]; then
    con="$(jq -r '.consoleErrors | length' "$rep" 2>/dev/null)"; net="$(jq -r '.failedRequests | length' "$rep" 2>/dev/null)"
    body="$body
_console errors: ${con:-0} • failed requests: ${net:-0} • unfunded test wallet • full trace on the QA box (run ${RUN_ID:-?})_"
  fi
  gh pr comment "$n" --repo "$repo" --body "$body" >/dev/null 2>>"$rd/run.log" || echo "warn: failed to post PR comment for #$n"

  state_set "$TARGET" pr-qa "pr${n}_last_id" "$cid" "pr${n}_runs_$today" "$((ran_today + 1))"
  processed=$((processed + 1))
  notes="$notes
- PR #$n (@$requester): $verdict, $bugs finding(s) — $preview"
done

{
  echo "# pr-qa — $TARGET ($repo)"
  echo
  if [ "$processed" -gt 0 ] || [ -n "$notes" ]; then echo "Processed this tick:$notes"; else echo "_no new $command_word requests_"; fi
} > "$rd/report.md"

if [ "$processed" -gt 0 ]; then
  result issues "ran $processed PR request(s), $total_bugs finding(s)" "$total_bugs" "" false "$head"
else
  result skipped "no new $command_word requests" 0 "" true "$head"
fi
