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
# Remote mode: point QA at a LIVE/already-deployed URL instead of booting the app locally. recon still runs
# on the local repo to derive flows; we just drive the remote origin (and assert its api_base). No boot/teardown.
remote_base="$(t_app "$TARGET" base_url)"
remote_mode=0; [ -n "$remote_base" ] && remote_mode=1
if [ "$remote_mode" != 1 ]; then
  [ -n "$start_cmd" ] && [ -n "$port" ] || { echo "# qa skipped — no app config (need start_cmd+port, or base_url for a live app) for $TARGET" > "$rd/report.md"; result skipped "no app config" 0 "" true "$head"; exit 0; }
fi
: "${health:=/}"; : "${steps:=10}"
sample=""; [ -n "$sample_rel" ] && { case "$sample_rel" in /*) sample="$sample_rel";; *) sample="$SENTINEL_HOME/$sample_rel";; esac; }
boot_timeout="$(t_app "$TARGET" boot_timeout)"; : "${boot_timeout:=60}"
host="$(t_app "$TARGET" host)"; : "${host:=127.0.0.1}"   # browser origin (some apps gate CORS/sessions on 'localhost' vs '127.0.0.1')
api_base="$(t_app "$TARGET" api_base)"                    # backend API base for flow-engine assertions (e.g. http://localhost:4000)
# Single source for the browser origin: the remote URL, or the locally-booted web port.
if [ "$remote_mode" = 1 ]; then qa_base="${remote_base%/}"; : "${api_base:=$qa_base}"; else qa_base="http://$host:$port"; fi
# Fail CLOSED: driving a non-local origin can act on live data (UI actions + authenticated api_request).
# Require an explicit opt-in so a stray base_url can't silently hammer staging/prod.
if [ "$remote_mode" = 1 ]; then
  allow_live="$(jq -r --arg t "$TARGET" '.targets[$t].agents.qa.app.allow_live_data // false' "$TARGETS_JSON" 2>/dev/null)"
  # Parse the EXACT host (no glob — 'localhost.evil.com' must NOT count as local).
  _hostport="${qa_base#*://}"; _hostport="${_hostport%%/*}"
  case "$_hostport" in "["*) _qhost="${_hostport%%]*}"; _qhost="${_qhost#[}";; *) _qhost="${_hostport%%:*}";; esac
  case "$_qhost" in
    localhost|127.0.0.1|::1) : ;;   # genuinely local — safe
    *) if [ "$allow_live" != true ]; then
         echo "REFUSING remote QA against a live origin ($qa_base) without allow_live_data"
         { echo "# QA — $TARGET — refused (live data)"; echo; echo "\`base_url\` = \`$qa_base\` is a non-local origin, so QA could act on live data there. Set \`qa.app.allow_live_data: true\` to proceed (and scope the goal/flows to read-only or non-destructive actions)."; } > "$rd/report.md"
         result skipped "remote live-data not allowed (set allow_live_data:true)" 0 "" true "$head"; exit 0
       fi ;;
  esac
fi
# Backend-auth capture (optional): how api_request grabs the app's own bearer. capture_url_re = a regex matched
# against request URLs to sniff the Authorization header (default /api/); storage_key = a localStorage key
# (substring) holding a bearer token as a fallback. Lets non-Supabase / non-/api/ apps be asserted too.
auth_capture_url_re="$(jq -r --arg t "$TARGET" '.targets[$t].agents.qa.app.auth.capture_url_re // ""' "$TARGETS_JSON" 2>/dev/null)"
auth_storage_key="$(jq -r --arg t "$TARGET" '.targets[$t].agents.qa.app.auth.storage_key // ""' "$TARGETS_JSON" 2>/dev/null)"
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
# Seed localStorage UX-state (config-driven, generic): e.g. skip a first-visit onboarding/terms modal that
# would block the agent. UX-STATE ONLY — never auth/token keys. Keys/values (+ a "_comment") in targets.json.
qa_seed_storage="$(jq -c --arg t "$TARGET" '.targets[$t].agents.qa.app.seed_local_storage // {}' "$TARGETS_JSON" 2>/dev/null)"
# Web3 dApp mode (optional): inject an UNFUNDED burner wallet + gate stubs (see pi-ext/qa-browser/web3.ts).
# The wallet key never enters the page/model/logs; transactions are never broadcast — no real funds can move.
web3_enabled="$(jq -r --arg t "$TARGET" '.targets[$t].agents.qa.app.web3.enabled // false' "$TARGETS_JSON" 2>/dev/null)"
web3_rpc="$(jq -r --arg t "$TARGET" '.targets[$t].agents.qa.app.web3.rpc // ""' "$TARGETS_JSON" 2>/dev/null)"
web3_chain="$(jq -r --arg t "$TARGET" '.targets[$t].agents.qa.app.web3.chain_id // 42161' "$TARGETS_JSON" 2>/dev/null)"
web3_stubs="$(jq -c --arg t "$TARGET" '.targets[$t].agents.qa.app.web3.stubs // []' "$TARGETS_JSON" 2>/dev/null)"
# Optional: supply a SPECIFIC key via an env-var NAME (value lives in config/sentinel.env, never in targets.json),
# and opt in to a FUNDED key. Only for a small capped canary — broadcasts stay blocked. Default = fresh unfunded burner.
web3_pk_env="$(jq -r --arg t "$TARGET" '.targets[$t].agents.qa.app.web3.private_key_env // empty' "$TARGETS_JSON" 2>/dev/null)"
web3_allow_funded="$(jq -r --arg t "$TARGET" '.targets[$t].agents.qa.app.web3.allow_funded // false' "$TARGETS_JSON" 2>/dev/null)"
web3_on=""; web3_wl_key=""; web3_pk=""; web3_allow_funded_flag=""
if [ "$web3_enabled" = true ]; then
  web3_on=1
  # Resolve the key by env-var NAME (like login creds) — kept out of targets.json and never logged.
  [ -n "$web3_pk_env" ] && web3_pk="${!web3_pk_env:-}"
  [ "$web3_allow_funded" = true ] && web3_allow_funded_flag=1
  # The whitelist-stub passphrase MUST equal the app's NEXT_PUBLIC_CRYPTO_KEY — read it from the same QA .env
  # so there is a single source of truth (no chance of drift between the stub and the app).
  [ -n "$qa_env_file" ] && [ -f "$qa_env_file" ] && web3_wl_key="$(grep -m1 '^NEXT_PUBLIC_CRYPTO_KEY=' "$qa_env_file" 2>/dev/null | cut -d= -f2-)"
fi

# Per-target model/depth overrides (fall back to the global env): lets one sentinel run a two-tier
# fleet — a cheap frequent target and a deep nightly target with a stronger model and more
# flows/attempts/steps. Loaded before dry-run so [dry] output reports the effective model.
_t_model="$(t_app "$TARGET" model)";        [ -n "$_t_model" ] && QA_MODEL="$_t_model"
_t_provider="$(t_app "$TARGET" provider)";  [ -n "$_t_provider" ] && QA_PROVIDER="$_t_provider"
_t_thinking="$(t_app "$TARGET" thinking)";  [ -n "$_t_thinking" ] && QA_THINKING="$_t_thinking"
# Numeric knobs fail CLOSED to the global default: digits only, length-capped (kills octal-prefix
# and integer-overflow edge cases), base-10 normalized, and range-bound so a config typo can never
# crash bash arithmetic or turn a run into an unbounded session.
_num_knob(){ # raw min max fallback
  local raw="$1" min="$2" max="$3" fb="$4" n
  case "$raw" in ''|*[!0-9]*) warn "flow knob '$raw' is not a positive integer — using $fb"; echo "$fb"; return;; esac
  if [ "${#raw}" -gt 4 ]; then warn "flow knob '$raw' out of range — using $fb"; echo "$fb"; return; fi
  n=$((10#$raw))
  if [ "$n" -ge "$min" ] && [ "$n" -le "$max" ]; then echo "$n"; else warn "flow knob '$raw' outside [$min,$max] — using $fb"; echo "$fb"; fi
}
# Normalize the GLOBAL env values first (same rules, hard fallbacks) — a typo'd sentinel.env value
# must fail closed exactly like a typo'd per-target one — then apply the per-target overrides.
FLOW_MAX="$(_num_knob "${FLOW_MAX:-2}" 1 20 2)"
FLOW_ATTEMPTS="$(_num_knob "${FLOW_ATTEMPTS:-2}" 1 5 2)"
FLOW_STEPS="$(_num_knob "${FLOW_STEPS:-90}" 10 300 90)"
_v="$(t_app "$TARGET" flow_max)";      [ -n "$_v" ] && FLOW_MAX="$(_num_knob "$_v" 1 20 "$FLOW_MAX")"
_v="$(t_app "$TARGET" flow_attempts)"; [ -n "$_v" ] && FLOW_ATTEMPTS="$(_num_knob "$_v" 1 5 "$FLOW_ATTEMPTS")"
_v="$(t_app "$TARGET" flow_steps)";    [ -n "$_v" ] && FLOW_STEPS="$(_num_knob "$_v" 10 300 "$FLOW_STEPS")"

if [ "$DRY_RUN" = 1 ]; then echo "[dry] would $([ "$remote_mode" = 1 ] && echo "drive remote $qa_base" || echo "boot '$start_cmd' on 127.0.0.1:$port") for $steps steps with $QA_MODEL"; echo "# qa dry-run" > "$rd/report.md"; result skipped "dry-run" 0 "" true "$head"; exit 0; fi

# Optional: boot a DIFFERENT branch in a throwaway worktree (never touches the real working tree).
orig_path="$path"; wt=""
if [ "$remote_mode" != 1 ] && [ "$qa_worktree" = true ] && [ -n "$qa_branch" ]; then
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
# Local-boot prep only (remote mode runs against an already-deployed app — nothing to drop or DB-guard here).
if [ "$remote_mode" != 1 ]; then
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
fi

qadir="$rd/artifacts/qa"; mkdir -p "$qadir"
if [ "$remote_mode" = 1 ]; then
  # No local process to start/teardown — just confirm the live app answers, then drive it.
  echo "remote mode: QA against $qa_base (no local boot)"
  curl -fsS --max-time 15 "$qa_base$health" >/dev/null 2>&1 || echo "WARN: $qa_base$health not reachable — proceeding anyway"
else
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
fi   # end local-boot block
# Engine: node-loop (v1, deterministic; default) or pi-native (v2, Mimo drives via pi's agent loop).
engine="$(t_app "$TARGET" engine)"; : "${engine:=${QA_ENGINE:-node-loop}}"

if [ "$remote_mode" = 1 ]; then echo "engine=$engine; driving $qa_base for up to $steps steps with $QA_MODEL"; else echo "app healthy; engine=$engine; driving up to $steps steps with $QA_MODEL"; fi

# Operator hooks (optional). pre_cmd GATES the run — nonzero exit aborts before the agent drives
# anything (e.g. a canary-wallet balance-floor check); post_cmd always runs after the engine while
# the app is still up (e.g. a janitor that closes anything a trading run left open). Both run from
# the target path with the run's QA context in env; secrets stay env-var-shaped (never in targets.json).
pre_cmd="$(t_app "$TARGET" pre_cmd)"; post_cmd="$(t_app "$TARGET" post_cmd)"
if [ -n "$pre_cmd" ]; then
  echo "pre_cmd gate: $pre_cmd"
  if ! ( cd "$path" && RUN_DIR="$rd" QA_BASE="$qa_base" QA_API_BASE="$api_base" WEB3_PK="$web3_pk" \
         run_to "${HOOK_TIMEOUT:-300}" bash -lc "$pre_cmd" ) >>"$rd/run.log" 2>&1; then
    echo "pre_cmd exited nonzero — aborting run before driving the app"
    { echo "# QA — $TARGET — pre_cmd gate failed"; echo; echo "\`$pre_cmd\` exited nonzero, so the run was aborted before the agent drove anything. See run.log for the hook's output."; } > "$rd/report.md"
    result error "pre_cmd gate failed" 0 "" false "$head"; exit 0
  fi
fi

case "$engine" in
  flow)
    # Autonomous deep QA: recon the repo → derive critical business flows (cached per commit) → run each
    # top flow as a deep agent session that asserts state in the UI AND the backend API.
    ext="$SENTINEL_HOME/pi-ext/qa-browser/index.ts"
    plan_dir="$VAR/plans"; mkdir -p "$plan_dir"; plan="$plan_dir/${TARGET}-${head:0:12}.json"
    # Static plan (optional): a hand-authored critical_flows JSON used VERBATIM — recon+derive are
    # skipped. Used DIRECTLY (never copied into the derived-plan cache, so removing/repointing
    # plan_file can't leave a stale static plan behind). Fail CLOSED on an invalid file: the
    # operator chose curated flows deliberately — silently exploring a live target with
    # recon-derived flows instead is exactly what they opted out of.
    plan_static="$(t_app "$TARGET" plan_file)"
    if [ -n "$plan_static" ]; then
      case "$plan_static" in /*) : ;; *) plan_static="$SENTINEL_HOME/$plan_static" ;; esac
      if jq -e '(.critical_flows | type) == "array" and (.critical_flows | length) > 0' "$plan_static" >/dev/null 2>&1; then
        echo "using static plan_file: $plan_static"
        plan="$plan_static"
      else
        echo "plan_file '$plan_static' is missing, unreadable, or has no critical_flows array — refusing to fall back to derived flows"
        { echo "# QA — $TARGET — invalid plan_file"; echo; echo "\`plan_file\` is configured but \`$plan_static\` is missing/invalid (needs a non-empty \`critical_flows\` array). Fix the file or unset \`plan_file\`."; } > "$rd/report.md"
        result error "invalid plan_file" 0 "" false "$head"; exit 0
      fi
    fi
    if [ ! -s "$plan" ]; then
      echo "recon + deriving test plan (Mimo from code structure)..."
      digest="$(node "$SENTINEL_HOME/bin/recon.js" "$path" 2>>"$rd/run.log")"
      read -r -d '' dprompt <<EOF
You are a senior QA engineer. From this codebase structure, infer the product and derive the critical END-TO-END business test flows a thorough human QA would run — the real workflows, their state transitions, and edge cases. Output ONLY JSON:
{"product":"<one line>","domain":"<...>","critical_flows":[{"name":"<short>","priority":"high|medium|low","why":"<...>","ui_steps":["..."],"backend_checks":["what to verify via the API"],"edge_cases":["..."]}]}
Give 6-9 critical_flows, highest priority first.

$digest
EOF
      run_to 220 node "$SENTINEL_HOME/bin/pi-ask.js" --provider "$QA_PROVIDER" --model "$QA_MODEL" --thinking "$QA_THINKING" --timeout 200 "$dprompt" > "$plan.raw" 2>>"$rd/run.log"
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
        QA_OUT="$fdir" QA_BASE="$qa_base" QA_GOAL="$fname" QA_API_BASE="$api_base" \
        QA_MODEL="$QA_MODEL" QA_MAX_TOOLCALLS="${FLOW_STEPS:-90}" QA_HEADLESS="$QA_HEADLESS" \
        QA_LOGIN_EMAIL="$login_email" QA_LOGIN_PASSWORD="$login_pw" QA_LOGIN_PATH="$login_path" QA_START_PATH="$start_path" \
        QA_AUTH_URL_RE="$auth_capture_url_re" QA_AUTH_STORAGE_KEY="$auth_storage_key" QA_SEED_STORAGE="$qa_seed_storage" \
        WEB3_ENABLED="$web3_on" WEB3_RPC="$web3_rpc" WEB3_CHAIN_ID="$web3_chain" WEB3_WL_KEY="$web3_wl_key" WEB3_STUBS="$web3_stubs" WEB3_PK="$web3_pk" WEB3_ALLOW_FUNDED="$web3_allow_funded_flag" \
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
    QA_OUT="$qadir" QA_BASE="$qa_base" QA_SAMPLE="$sample" QA_GOAL="$goal" \
    QA_MODEL="$QA_MODEL" QA_MAX_TOOLCALLS="$((steps * 2))" QA_HEADLESS="$QA_HEADLESS" \
    QA_LOGIN_EMAIL="$login_email" QA_LOGIN_PASSWORD="$login_pw" QA_LOGIN_PATH="$login_path" QA_START_PATH="$start_path" \
    QA_AUTH_URL_RE="$auth_capture_url_re" QA_AUTH_STORAGE_KEY="$auth_storage_key" QA_SEED_STORAGE="$qa_seed_storage" \
    WEB3_ENABLED="$web3_on" WEB3_RPC="$web3_rpc" WEB3_CHAIN_ID="$web3_chain" WEB3_WL_KEY="$web3_wl_key" WEB3_STUBS="$web3_stubs" WEB3_PK="$web3_pk" WEB3_ALLOW_FUNDED="$web3_allow_funded_flag" \
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
        --base "$qa_base" --out "$qadir" --steps "$steps" --goal "$goal" \
        --provider "$QA_PROVIDER" --model "$QA_MODEL" --thinking "$QA_THINKING" \
        --headless "$QA_HEADLESS" ${sample:+--sample "$sample"} --pi-timeout 120 \
      >>"$rd/run.log" 2>&1 || echo "warn: qa-drive nonzero exit"
    ;;
esac

# post_cmd runs while the app (local mode) is still up, on every engine outcome — a janitor here can
# reach both the app and the backend. Failure is reported but never fails the run.
if [ -n "$post_cmd" ]; then
  echo "post_cmd: $post_cmd"
  ( cd "$path" && RUN_DIR="$rd" QA_BASE="$qa_base" QA_API_BASE="$api_base" WEB3_PK="$web3_pk" \
    run_to "${HOOK_TIMEOUT:-300}" bash -lc "$post_cmd" ) >>"$rd/run.log" 2>&1 || echo "warn: post_cmd exited nonzero (see run.log)"
fi

[ "$remote_mode" != 1 ] && { teardown; trap - EXIT; }

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
  if [ "$remote_mode" = 1 ]; then echo "- app: $qa_base (remote)  •  engine: $engine  •  HEAD: \`${head:0:7}\`"; else echo "- app: \`$start_cmd\` on 127.0.0.1:$port  •  engine: $engine  •  HEAD: \`${head:0:7}\`"; fi
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

# Findings → tracker (optional, qa.issues.repo): file each NEW functional bug as a GitHub issue.
# Dedup is persisted per target (var/state/<target>__qa-issues.json keyed by a normalized-description
# hash), so the same bug found on a later run is never re-filed. max_per_run caps a pathological run
# from flooding the tracker; capped-out findings stay in the report. Issue URLs land in the report,
# and in result.json (.issue_urls) so the dispatch webhook brief links them.
issues_repo="$(jq -r --arg t "$TARGET" '.targets[$t].agents.qa.issues.repo // ""' "$TARGETS_JSON" 2>/dev/null)"
issue_urls="[]"
if [ -n "$issues_repo" ] && [ "$bugs" -gt 0 ] 2>/dev/null; then
  issues_min="$(jq -r --arg t "$TARGET" '.targets[$t].agents.qa.issues.min_severity // "medium"' "$TARGETS_JSON" 2>/dev/null)"
  issues_max="$(jq -r --arg t "$TARGET" '.targets[$t].agents.qa.issues.max_per_run // 5' "$TARGETS_JSON" 2>/dev/null)"
  # Flood cap must fail CLOSED: a malformed max_per_run falls back to the default, never to "unlimited".
  case "$issues_max" in ''|*[!0-9]*) echo "warn: qa.issues.max_per_run '$issues_max' is not a number — using 5"; issues_max=5;; esac
  sev_rank(){ case "$1" in critical) echo 3;; high) echo 2;; medium) echo 1;; *) echo 0;; esac; }
  hash_stdin(){ if have sha256sum; then sha256sum; else shasum -a 256; fi; }
  min_rank="$(sev_rank "$issues_min")"
  seen_f="$STATE/${TARGET}__qa-issues.json"; [ -f "$seen_f" ] || echo '{}' > "$seen_f"
  # Corrupt dedup state must fail CLOSED (skip filing, findings stay in the report) — filing with
  # broken state would re-file every historical bug as new.
  if ! jq -e 'type == "object"' "$seen_f" >/dev/null 2>&1; then
    echo "warn: issue-dedup state $seen_f is corrupt — SKIPPING issue filing this run (findings remain in the report; fix or delete the file)"
  else
  filed=0
  while IFS=$'\t' read -r sev desc; do
    [ -n "$desc" ] || continue
    [ "$(sev_rank "$sev")" -lt "$min_rank" ] && continue
    # Dedup key: normalized description (lowercased, whitespace-squeezed, first 160 chars) — severity-agnostic
    # so a re-grade of the same finding doesn't double-file.
    key="$(printf '%s' "$desc" | tr '[:upper:]' '[:lower:]' | tr -s '[:space:]' ' ' | cut -c1-160 | hash_stdin | cut -d' ' -f1)"
    [ -n "$(jq -r --arg k "$key" '.[$k] // empty' "$seen_f")" ] && continue
    if [ "$filed" -ge "$issues_max" ]; then echo "issue cap ($issues_max) reached — remaining new findings stay in the report"; break; fi
    title="[sentinel-qa] $sev: $(printf '%s' "$desc" | cut -c1-90)"
    body="Found by a scheduled Sentinel QA run against \`$qa_base\`.

**Severity:** $sev

$desc

_run \`${RUN_ID:-?}\` • verdict $v • $(date -u '+%Y-%m-%d %H:%MZ')_"
    if url="$(gh issue create --repo "$issues_repo" --title "$title" --body "$body" 2>>"$rd/run.log")"; then
      tmp="$(mktemp)"; jq --arg k "$key" --arg u "$url" '.[$k]=$u' "$seen_f" > "$tmp" && mv "$tmp" "$seen_f"
      issue_urls="$(jq -c --arg u "$url" '. + [$u]' <<<"$issue_urls")"
      filed=$((filed+1))
    else
      echo "warn: gh issue create failed for: $title"
    fi
  done < <(jq -r '.bugs[] | [.severity, .desc] | @tsv' "$rep" 2>/dev/null)
  if [ "$filed" -gt 0 ]; then
    { echo; echo "## Filed issues"; jq -r '.[]' <<<"$issue_urls" | sed 's/^/- /'; } >> "$rd/report.md"
    echo "filed $filed new issue(s) on $issues_repo"
  fi
  fi   # end corrupt-state guard
fi

result "$v" "${summary:0:180} • ${uiux_count:-0} UI/UX findings" "$bugs" "$cost" false "$head"
[ "$issue_urls" != "[]" ] && { tmp="$(mktemp)"; jq --argjson iu "$issue_urls" '.issue_urls=$iu' "$rd/result.json" > "$tmp" && mv "$tmp" "$rd/result.json"; }
echo "done: $v ($bugs functional bugs, ${uiux_count:-0} UI/UX findings)"
