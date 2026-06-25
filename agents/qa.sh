#!/usr/bin/env bash
# qa agent — boot the app on 127.0.0.1, run an agentic Mimo+Playwright loop, report bugs.
# Read-only against the app; never writes to the repo. Inputs (env): RUN_DIR TARGET TARGET_PATH AI_ALLOWED.
. "$SENTINEL_HOME/lib/common.sh"
path="$TARGET_PATH"; rd="$RUN_DIR"; head="$(git_head "$path")"

result(){ jq -n --arg v "$1" --arg s "$2" --argjson f "${3:-0}" --arg c "${4:-}" --argjson sk "${5:-false}" --arg sha "${6:-}" \
  '{verdict:$v,summary:$s,findings:$f,cost:$c,skipped:$sk,sha:$sha}' > "$rd/result.json"; }

if [ "$AI_ALLOWED" != "true" ]; then echo "# qa skipped — ai_allowed is false" > "$rd/report.md"; result skipped "ai_allowed=false" 0 "" true "$head"; exit 0; fi

start_cmd="$(t_app "$TARGET" start_cmd)"; port="$(t_app "$TARGET" port)"; health="$(t_app "$TARGET" health_path)"
steps="$(t_app "$TARGET" max_steps)"; goal="$(t_app "$TARGET" goal)"; sample_rel="$(t_app "$TARGET" sample_image)"
[ -n "$start_cmd" ] && [ -n "$port" ] || { echo "# qa skipped — no app config (start_cmd/port) for $TARGET" > "$rd/report.md"; result skipped "no app config" 0 "" true "$head"; exit 0; }
: "${health:=/}"; : "${steps:=10}"
sample=""; [ -n "$sample_rel" ] && { case "$sample_rel" in /*) sample="$sample_rel";; *) sample="$SENTINEL_HOME/$sample_rel";; esac; }
boot_timeout="$(t_app "$TARGET" boot_timeout)"; : "${boot_timeout:=60}"
host="$(t_app "$TARGET" host)"; : "${host:=127.0.0.1}"   # browser origin (some apps gate CORS/sessions on 'localhost' vs '127.0.0.1')
api_base="$(t_app "$TARGET" api_base)"                    # backend API base for flow-engine assertions (e.g. http://localhost:4000)
aux_ports="$(jq -r --arg t "$TARGET" '.targets[$t].agents.qa.app.aux_ports[]? // empty' "$TARGETS_JSON" 2>/dev/null | tr '\n' ' ')"
all_ports="$port $aux_ports"
# Login (optional): targets.json references env-var NAMES; the secrets live only in config/sentinel.env and are
# typed into the form by Playwright — NEVER placed in the model prompt, the trace, or any log.
login_path="$(jq -r --arg t "$TARGET" '.targets[$t].agents.qa.app.login.path // "/login"' "$TARGETS_JSON" 2>/dev/null)"
le_env="$(jq -r --arg t "$TARGET" '.targets[$t].agents.qa.app.login.email_env // empty' "$TARGETS_JSON" 2>/dev/null)"
lp_env="$(jq -r --arg t "$TARGET" '.targets[$t].agents.qa.app.login.password_env // empty' "$TARGETS_JSON" 2>/dev/null)"
login_email=""; login_pw=""
[ -n "$le_env" ] && login_email="${!le_env:-}"
[ -n "$lp_env" ] && login_pw="${!lp_env:-}"

# Branch / worktree boot (optional): QA a branch other than the checked-out one, in a THROWAWAY git
# worktree — the target's real working tree is never touched. Deps install into the worktree.
qa_branch="$(t_app "$TARGET" branch)"
qa_worktree="$(t_app "$TARGET" worktree)"
qa_install="$(t_app "$TARGET" install_cmd)"
qa_env_file="$(t_app "$TARGET" qa_env)"   # gitignored .env dropped into the app dir as .env.local before boot
case "$qa_env_file" in /*|"") : ;; *) qa_env_file="$SENTINEL_HOME/$qa_env_file" ;; esac
start_path="$(t_app "$TARGET" start_path)"   # path the agent opens first (default "/"); use when "/" needs a backend
# Web3 dApp mode (optional): inject an UNFUNDED burner wallet + gate stubs (see pi-ext/qa-browser/web3.ts).
# The wallet key never enters the page/model/logs; transactions are never broadcast — no real funds can move.
web3_enabled="$(jq -r --arg t "$TARGET" '.targets[$t].agents.qa.app.web3.enabled // false' "$TARGETS_JSON" 2>/dev/null)"
web3_rpc="$(jq -r --arg t "$TARGET" '.targets[$t].agents.qa.app.web3.rpc // ""' "$TARGETS_JSON" 2>/dev/null)"
web3_chain="$(jq -r --arg t "$TARGET" '.targets[$t].agents.qa.app.web3.chain_id // 42161' "$TARGETS_JSON" 2>/dev/null)"
web3_stubs="$(jq -c --arg t "$TARGET" '.targets[$t].agents.qa.app.web3.stubs // []' "$TARGETS_JSON" 2>/dev/null)"
web3_on=""; web3_wl_key=""
if [ "$web3_enabled" = true ]; then
  web3_on=1
  # The whitelist-stub passphrase MUST equal the app's NEXT_PUBLIC_CRYPTO_KEY — read it from the same QA .env
  # so there is a single source of truth (no chance of drift between the stub and the app).
  [ -n "$qa_env_file" ] && [ -f "$qa_env_file" ] && web3_wl_key="$(grep -m1 '^NEXT_PUBLIC_CRYPTO_KEY=' "$qa_env_file" 2>/dev/null | cut -d= -f2-)"
fi

if [ "$DRY_RUN" = 1 ]; then echo "[dry] would boot '$start_cmd' on 127.0.0.1:$port then drive $steps steps with $QA_MODEL"; echo "# qa dry-run" > "$rd/report.md"; result skipped "dry-run" 0 "" true "$head"; exit 0; fi

# Optional: boot a DIFFERENT branch in a throwaway worktree (never touches the real working tree).
orig_path="$path"; wt=""
if [ "$qa_worktree" = true ] && [ -n "$qa_branch" ]; then
  wt="$VAR/worktrees/$TARGET"
  echo "preparing worktree for branch '$qa_branch' (real working tree untouched)..."
  git -C "$orig_path" worktree remove --force "$wt" 2>/dev/null || true; rm -rf "$wt" 2>/dev/null
  git -C "$orig_path" worktree prune 2>/dev/null || true
  git -C "$orig_path" fetch -q origin "$qa_branch" 2>>"$rd/run.log" || true
  if git -C "$orig_path" worktree add --force --detach "$wt" "origin/$qa_branch" 2>>"$rd/run.log" \
     || git -C "$orig_path" worktree add --force --detach "$wt" "$qa_branch" 2>>"$rd/run.log"; then
    path="$wt"; head="$(git_head "$path")"
    if [ -n "$qa_install" ] && [ ! -d "$path/node_modules" ]; then
      echo "installing deps in worktree (one-time, can take a few min): $qa_install"
      ( cd "$path" && run_to "${INSTALL_TIMEOUT:-900}" bash -lc "$qa_install" ) >>"$rd/run.log" 2>&1 || echo "warn: install_cmd failed or timed out (boot may fail)"
    fi
  else
    echo "# QA — $TARGET — could not create worktree for branch '$qa_branch'" > "$rd/report.md"
    result error "worktree add failed for $qa_branch" 0 "" false "$head"; exit 0
  fi
fi
# Drop the gitignored QA .env into the app dir (NEXT_PUBLIC_* must be present before boot). Worktree-local.
if [ -n "$qa_env_file" ] && [ -f "$qa_env_file" ]; then cp "$qa_env_file" "$path/.env.local" && echo "wrote QA .env.local into app dir"; fi
# Web3 QA: refuse to drive if the QA env's DB could reach real data (defense beyond the network stub layer).
if [ "$web3_on" = 1 ] && [ -n "$qa_env_file" ] && [ -f "$qa_env_file" ]; then
  _murl="$(grep -m1 '^MONGODB_URI=' "$qa_env_file" 2>/dev/null | cut -d= -f2-)"
  case "$_murl" in
    ""|*127.0.0.1*|*localhost*) : ;;
    *) echo "REFUSING web3 QA: MONGODB_URI in QA env is not loopback"
       { echo "# QA — $TARGET — unsafe MONGODB_URI"; echo; echo "web3 QA requires a loopback/empty MONGODB_URI in the QA env so the app's own API routes cannot reach a real database. Got a non-loopback host — refusing."; } > "$rd/report.md"
       result error "unsafe MONGODB_URI for web3 QA" 0 "" false "$head"; exit 0 ;;
  esac
fi

qadir="$rd/artifacts/qa"; mkdir -p "$qadir"
applog="$rd/artifacts/app.log"
# Refuse to boot over (or later kill) a process we didn't start — check EVERY port we'll use.
for _p in $all_ports; do
  if lsof -ti tcp:"$_p" >/dev/null 2>&1; then
    echo "port $_p already in use — refusing to boot or touch it"
    { echo "# QA — $TARGET — port $_p busy"; echo; echo "Something is already listening on 127.0.0.1:$_p (used by $TARGET). Sentinel won't boot over it or kill it. Stop that process, or change the port."; } > "$rd/report.md"
    result skipped "port $_p already in use" 0 "" true "$head"; exit 0
  fi
done
# Single-process apps want PORT injected; multi-process stacks (web+api) must NOT
# have one PORT forced on every child — set_port:false lets each process use its own configured port.
set_port="$(jq -r --arg t "$TARGET" '.targets[$t].agents.qa.app.set_port' "$TARGETS_JSON" 2>/dev/null)"
# Plain background boot — keep the app attached. (A new session via setsid detaches the controlling TTY,
# and interactive dev servers like `next dev` exit without one. We reap the multi-process tree in teardown
# via port + path-scoped pkill instead.)
echo "booting app: $start_cmd  (web 127.0.0.1:$port$health${aux_ports:+ • aux:$aux_ports})"
if [ "$set_port" = false ]; then
  ( cd "$path" && PATH="$path/node_modules/.bin:$PATH" bash -lc "$start_cmd" ) > "$applog" 2>&1 &
else
  ( cd "$path" && PORT="$port" HOST=127.0.0.1 PATH="$path/node_modules/.bin:$PATH" bash -lc "$start_cmd" ) > "$applog" 2>&1 &
fi
app_pid=$!
# Ports were free before we booted, so anything on them now is ours to reap. Reap by port + repo path
# (next/tsx carry the repo path; killing them drops the pnpm --filter parents). Fires on every exit path.
teardown(){
  kill "$app_pid" 2>/dev/null; pkill -P "$app_pid" 2>/dev/null
  for _p in $all_ports; do lsof -ti tcp:"$_p" 2>/dev/null | xargs kill -9 2>/dev/null || true; done
  [ -n "$path" ] && { pkill -f "$path" 2>/dev/null; pkill -f "$(basename "$path")" 2>/dev/null; }  # full path catches next/tsx; basename catches pnpm --filter @scope
  sleep 1
  for _p in $all_ports; do lsof -ti tcp:"$_p" 2>/dev/null | xargs kill -9 2>/dev/null || true; done
  # Remove the throwaway worktree (after processes holding its files are reaped).
  [ -n "$wt" ] && { git -C "$orig_path" worktree remove --force "$wt" 2>/dev/null || rm -rf "$wt" 2>/dev/null; git -C "$orig_path" worktree prune 2>/dev/null; }
  true
}
trap teardown EXIT INT TERM

up=0; for i in $(seq 1 "$boot_timeout"); do curl -fsS "http://127.0.0.1:$port$health" >/dev/null 2>&1 && { up=1; break; }; kill -0 "$app_pid" 2>/dev/null || break; sleep 1; done
if [ "$up" != 1 ]; then
  echo "app did not become healthy in ${boot_timeout}s"
  { echo "# QA — $TARGET — app failed to boot"; echo; echo "\`$start_cmd\` never answered on 127.0.0.1:$port$health within ${boot_timeout}s."; echo; echo "## app.log (tail)"; echo '```'; tail -50 "$applog"; echo '```'; } > "$rd/report.md"
  result fail "app did not boot on :$port" 1 "" false "$head"; exit 0
fi
# Wait for aux services (e.g. the api) so QA tests the whole stack, not a backend-less frontend.
for _p in $aux_ports; do
  aok=0; for i in $(seq 1 "$boot_timeout"); do lsof -ti tcp:"$_p" >/dev/null 2>&1 && { aok=1; break; }; kill -0 "$app_pid" 2>/dev/null || break; sleep 1; done
  [ "$aok" = 1 ] && echo "aux port $_p up" || echo "WARN: aux port $_p never came up — QA may see backend-down"
done
# Engine: node-loop (v1, deterministic; default) or pi-native (v2, Mimo drives via pi's agent loop).
engine="$(t_app "$TARGET" engine)"; : "${engine:=${QA_ENGINE:-node-loop}}"
echo "app healthy; engine=$engine; driving up to $steps steps with $QA_MODEL"

case "$engine" in
  flow)
    # Autonomous deep QA: recon the repo → derive critical business flows (cached per commit) → run each
    # top flow as a deep agent session that asserts state in the UI AND the backend API.
    ext="$SENTINEL_HOME/pi-ext/qa-browser/index.ts"
    plan_dir="$VAR/plans"; mkdir -p "$plan_dir"; plan="$plan_dir/${TARGET}-${head:0:12}.json"
    if [ ! -s "$plan" ]; then
      echo "recon + deriving test plan (Mimo from code structure)..."
      digest="$(node "$SENTINEL_HOME/bin/recon.js" "$path" 2>>"$rd/run.log")"
      read -r -d '' dprompt <<EOF
You are a senior QA engineer. From this codebase structure, infer the product and derive the critical END-TO-END business test flows a thorough human QA would run — the real workflows, their state transitions, and edge cases. Output ONLY JSON:
{"product":"<one line>","domain":"<...>","critical_flows":[{"name":"<short>","priority":"high|medium|low","why":"<...>","ui_steps":["..."],"backend_checks":["what to verify via the API"],"edge_cases":["..."]}]}
Give 6-9 critical_flows, highest priority first.

$digest
EOF
      run_to 220 node "$SENTINEL_HOME/bin/pi-ask.js" --provider "$QA_PROVIDER" --model "$QA_MODEL" --thinking medium --timeout 200 "$dprompt" > "$plan.raw" 2>>"$rd/run.log"
      python3 -c "import sys,json; t=open('$plan.raw').read(); i=t.find('{'); j=t.rfind('}'); s=t[i:j+1] if (i>=0 and j>i) else '{}'; json.loads(s); open('$plan','w').write(s)" 2>>"$rd/run.log" || echo '{"critical_flows":[]}' > "$plan"
    fi
    nflows="$(jq -r '.critical_flows|length' "$plan" 2>/dev/null || echo 0)"
    maxflows="${FLOW_MAX:-2}"; n=$(( nflows < maxflows ? nflows : maxflows ))
    echo "plan: $(jq -r '.product // "?"' "$plan") — deep-testing top $n of $nflows flows"
    : "${api_base:=http://$host:${aux_ports%% *}}"
    i=0
    while [ "$i" -lt "$n" ]; do
      fname="$(jq -r ".critical_flows[$i].name" "$plan")"
      fwhy="$(jq -r ".critical_flows[$i].why // \"\"" "$plan")"
      fui="$(jq -r ".critical_flows[$i].ui_steps // [] | join(\" → \")" "$plan")"
      fbe="$(jq -r ".critical_flows[$i].backend_checks // [] | join(\" ; \")" "$plan")"
      fec="$(jq -r ".critical_flows[$i].edge_cases // [] | join(\" ; \")" "$plan")"
      echo "▶ flow $((i+1))/$n: $fname  (${FLOW_ATTEMPTS:-2} attempt(s) — findings unioned)"
      read -r -d '' fprompt <<EOF
You are an autonomous QA engineer executing ONE end-to-end test flow on a REAL web app you are already logged into. Drive it to completion and VERIFY the outcome on BOTH the UI and the BACKEND API.

FLOW: $fname
WHY IT MATTERS: $fwhy
UI STEPS: $fui
BACKEND CHECKS: $fbe
EDGE CASES TO PROBE: $fec

Work the BACKEND CHECKS and EDGE CASES above as a MANDATORY CHECKLIST — attempt every one and report its result. Be SKEPTICAL: assume something is broken until you have proven it works.
Method: perform each UI step (click/type/upload/navigate). After EVERY create or update, do BOTH:
  (a) api_request to confirm the backend truly persisted it (record fields, status transitions, availability/inventory counts), and
  (b) browser_snapshot the views that should reflect it (calendar, list, detail) to confirm the UI actually shows the change.
A mismatch between what the API/backend holds and what the UI shows is a BUG. A status/state the API did NOT actually update (even if the UI looks fine) is a BUG. Missing endpoints, wrong data, pages that don't render, and mishandled edge cases are bugs. Call report_bug (severity low|medium|high|critical) for each.
Do NOT conclude the flow "works" without having run each backend check AND seen the UI update consistently. When the checklist is done (or you are blocked), call finish with verdict pass|issues|fail and a summary that states the result of each backend check and edge case.
Stay within this app's origin. Be thorough, skeptical, and persistent — this is a DEEP flow test, not a click-around.
EOF
      a=1
      while [ "$a" -le "${FLOW_ATTEMPTS:-2}" ]; do
        fdir="$qadir/flow-$i-a$a"; mkdir -p "$fdir"
        [ "${FLOW_ATTEMPTS:-2}" -gt 1 ] && echo "    attempt $a/${FLOW_ATTEMPTS:-2}"
        QA_OUT="$fdir" QA_BASE="http://$host:$port" QA_GOAL="$fname" QA_API_BASE="$api_base" \
        QA_MODEL="$QA_MODEL" QA_MAX_TOOLCALLS="${FLOW_STEPS:-90}" QA_HEADLESS="$QA_HEADLESS" \
        QA_LOGIN_EMAIL="$login_email" QA_LOGIN_PASSWORD="$login_pw" QA_LOGIN_PATH="$login_path" QA_START_PATH="$start_path" \
        WEB3_ENABLED="$web3_on" WEB3_RPC="$web3_rpc" WEB3_CHAIN_ID="$web3_chain" WEB3_WL_KEY="$web3_wl_key" WEB3_STUBS="$web3_stubs" \
        run_to "$CMD_TIMEOUT" pi -p -nbt --no-session -e "$ext" \
          --tools browser_snapshot,browser_click,browser_type,browser_upload,browser_navigate,browser_scroll,api_request,report_bug,finish \
          --provider "$QA_PROVIDER" --model "$QA_MODEL" --thinking "$QA_THINKING" --mode json \
          "$fprompt" > "$fdir/pi.jsonl" 2>>"$rd/run.log" || echo "warn: flow $i attempt $a nonzero exit"
        if [ -f "$fdir/report.json" ]; then
          fc="$(jq -s '[.[]|select(.type=="message_end" and .message.role=="assistant")|.message.usage.cost.total // 0]|add // 0' "$fdir/pi.jsonl" 2>/dev/null)"
          [ -n "$fc" ] && { ftmp="$(mktemp)"; jq --arg c "$fc" '.cost=$c' "$fdir/report.json" > "$ftmp" && mv "$ftmp" "$fdir/report.json"; }
        fi
        a=$((a + 1))
      done
      i=$((i + 1))
    done
    node "$SENTINEL_HOME/bin/merge-flows.js" "$qadir" "$plan" >>"$rd/run.log" 2>&1 || echo "warn: merge-flows failed"
    ;;
  pi-native)
    ext="$SENTINEL_HOME/pi-ext/qa-browser/index.ts"
    pilog="$rd/artifacts/pi-qa.jsonl"
    read -r -d '' qprompt <<EOF
$goal

You are an autonomous QA tester driving a REAL web app through browser tools. Workflow:
1) call browser_snapshot to see the page (URL, title, numbered interactive elements, and any errors)
2) use browser_click / browser_type / browser_upload / browser_navigate / browser_scroll (by the element index) to exercise the goal
3) call browser_snapshot again after actions to observe the result and any new errors
4) when you find a REAL defect, call report_bug (severity low|medium|high|critical + a concrete description)
5) when the goal is covered or you are stuck, call finish with a verdict (pass|issues|fail) and a short summary
You start already authenticated where applicable — do NOT log out, do NOT visit /login, and do NOT navigate to a different host/port/origin (it loses your session). Explore only within this app.
Keep it under $steps snapshots. Don't repeat the same action — make progress toward the goal each step.
EOF
    QA_OUT="$qadir" QA_BASE="http://$host:$port" QA_SAMPLE="$sample" QA_GOAL="$goal" \
    QA_MODEL="$QA_MODEL" QA_MAX_TOOLCALLS="$((steps * 2))" QA_HEADLESS="$QA_HEADLESS" \
    QA_LOGIN_EMAIL="$login_email" QA_LOGIN_PASSWORD="$login_pw" QA_LOGIN_PATH="$login_path" QA_START_PATH="$start_path" \
    WEB3_ENABLED="$web3_on" WEB3_RPC="$web3_rpc" WEB3_CHAIN_ID="$web3_chain" WEB3_WL_KEY="$web3_wl_key" WEB3_STUBS="$web3_stubs" \
    run_to "$CMD_TIMEOUT" pi -p -nbt --no-session -e "$ext" \
      --tools browser_snapshot,browser_click,browser_type,browser_upload,browser_navigate,browser_scroll,report_bug,finish \
      --provider "$QA_PROVIDER" --model "$QA_MODEL" --thinking "$QA_THINKING" --mode json \
      "$qprompt" > "$pilog" 2>>"$rd/run.log" || echo "warn: pi-native nonzero exit"
    # The extension writes report.json; inject the total agent cost parsed from pi's JSONL.
    if [ -f "$qadir/report.json" ]; then
      cost="$(jq -s '[.[]|select(.type=="message_end" and .message.role=="assistant")|.message.usage.cost.total // 0]|add // 0' "$pilog" 2>/dev/null)"
      [ -n "$cost" ] && [ "$cost" != "0" ] && { tmp="$(mktemp)"; jq --arg c "$cost" '.cost=$c' "$qadir/report.json" > "$tmp" && mv "$tmp" "$qadir/report.json"; }
    fi
    ;;
  *)  # node-loop (v1)
    NODE_PATH="$SENTINEL_HOME/node_modules" run_to "$CMD_TIMEOUT" \
      node "$SENTINEL_HOME/bin/qa-drive.js" \
        --base "http://$host:$port" --out "$qadir" --steps "$steps" --goal "$goal" \
        --provider "$QA_PROVIDER" --model "$QA_MODEL" --thinking "$QA_THINKING" \
        --headless "$QA_HEADLESS" ${sample:+--sample "$sample"} --pi-timeout 120 \
      >>"$rd/run.log" 2>&1 || echo "warn: qa-drive nonzero exit"
    ;;
esac

teardown; trap - EXIT

rep="$qadir/report.json"
if [ ! -f "$rep" ]; then
  echo "qa-drive produced no report.json"
  { echo "# QA — $TARGET — driver error"; echo; echo "The browser driver did not produce a report. See run.log + app.log."; } > "$rd/report.md"
  result error "driver produced no report" 0 "" false "$head"; exit 0
fi

# UI/UX review (vision via mimo-v2-omni) over the captured screens — the design/usability lens the
# DOM-based functional QA can't see (visual hierarchy, spacing, contrast/WCAG, typography, states).
uiux_count=0
if [ "$(t_app "$TARGET" uiux_review)" != false ]; then
  echo "UI/UX vision review (mimo-v2-omni) over captured screens..."
  run_to "$CMD_TIMEOUT" node "$SENTINEL_HOME/bin/uiux-review.js" --report "$rep" --out "$qadir" --app "$TARGET" --max-screens "${UIUX_MAX_SCREENS:-8}" >>"$rd/run.log" 2>&1 || echo "warn: uiux-review failed"
  [ -f "$qadir/uiux.json" ] && uiux_count="$(jq -r '.totalFindings // 0' "$qadir/uiux.json" 2>/dev/null)"; [ "$uiux_count" -eq "$uiux_count" ] 2>/dev/null || uiux_count=0
fi

verdict="$(jq -r '.verdict // "unknown"' "$rep")"; bugs="$(jq -r '.bugs | length' "$rep")"; cost="$(jq -r '.cost // ""' "$rep")"
summary="$(jq -r '.summary // ""' "$rep")"
case "$verdict" in pass) v=pass;; fail) v=fail;; *) v=issues;; esac

{
  echo "# QA — $TARGET"
  echo; echo "- verdict: **$v**  •  functional bugs: **$bugs**  •  UI/UX findings: **${uiux_count:-0}**  •  steps: $(jq -r '.steps|length' "$rep")  •  model: $QA_MODEL${cost:+  •  cost: \$$cost}"
  echo "- app: \`$start_cmd\` on 127.0.0.1:$port  •  engine: $engine  •  HEAD: \`${head:0:7}\`"
  echo "- screenshots + trace: \`$qadir/report.html\`"
  echo; echo "## Summary"; echo "$summary"
  if [ -f "$qadir/flows.json" ]; then
    echo; echo "## Flow tests (autonomous, deep — frontend + backend)"
    echo "_$(jq -r '.product // "product"' "$qadir/flows.json")_"
    jq -r '.flows[] | "- **\(.name)** → **\(.verdict)** (\(.bugs) bugs) — \(.summary[0:200])"' "$qadir/flows.json" 2>/dev/null
  fi
  echo; echo "## Bugs"
  jq -r '.bugs[] | "- **[\(.severity)]** \(.desc)"' "$rep" 2>/dev/null || echo "_none_"
  con="$(jq -r '.consoleErrors | length' "$rep" 2>/dev/null)"; [ -n "$con" ] && [ "$con" -eq "$con" ] 2>/dev/null || con=0
  net="$(jq -r '.failedRequests | length' "$rep" 2>/dev/null)"; [ -n "$net" ] && [ "$net" -eq "$net" ] 2>/dev/null || net=0
  echo; echo "## Signals"; echo "- console errors: $con  •  failed requests: $net"
  [ "$con" -gt 0 ] && { echo; echo "Console errors:"; echo '```'; jq -r '.consoleErrors[]' "$rep" | head -20; echo '```'; }
  if [ -f "$qadir/uiux.json" ] && [ "${uiux_count:-0}" -gt 0 ]; then
    echo; echo "## UI/UX review — vision (mimo-v2-omni)"
    echo "$uiux_count design/usability findings across $(jq -r '.screens|length' "$qadir/uiux.json") screens (visual hierarchy, spacing, contrast/WCAG, typography, states, consistency):"
    jq -r '.screens[] | select(.findings|length>0) | "\n**\(.screen)** — _\(.summary)_", (.findings[] | "- [\(.severity)/\(.dimension)] **\(.title)** — \(.detail) → _\(.recommendation)_")' "$qadir/uiux.json" 2>/dev/null
  fi
  echo; echo "## Action trace"
  jq -r '.steps[] | "\(.n). \(.action.type)\(if .action.index!=null then " #\(.action.index)" else "" end) — \(.observation // "")"' "$rep" 2>/dev/null | head -40
} > "$rd/report.md"

[ "$engine" = flow ] && node "$SENTINEL_HOME/bin/render-report.js" "$qadir" >>"$rd/run.log" 2>&1
cp "$qadir/report.html" "$rd/artifacts/report.html" 2>/dev/null || true
result "$v" "${summary:0:180} • ${uiux_count:-0} UI/UX findings" "$bugs" "$cost" false "$head"
echo "done: $v ($bugs functional bugs, ${uiux_count:-0} UI/UX findings)"
