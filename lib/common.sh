#!/usr/bin/env bash
# lib/common.sh — shared helpers for Sentinel. Source this; don't execute.
# Contract used by bin/sentinel and agents/*.sh.
set -uo pipefail

SENTINEL_HOME="${SENTINEL_HOME:-$HOME/sentinel}"
ENV_FILE="$SENTINEL_HOME/config/sentinel.env"

# Load config as DEFAULTS only — vars already set in the environment always win.
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r _line; do
    case "$_line" in ''|\#*) continue ;; esac
    _line="${_line%% #*}"                                  # strip inline ' #comment'
    _line="${_line%"${_line##*[![:space:]]}"}"             # rtrim trailing whitespace
    [ -z "$_line" ] && continue
    _key="${_line%%=*}"
    case "$_key" in *[!A-Za-z0-9_]*|'') continue ;; esac
    eval "_isset=\${$_key+set}"
    [ -n "${_isset:-}" ] && continue                       # caller env wins
    case "$_line" in *'$('*|*'`'*|*';'*|*'&'*|*'|'*) printf 'sentinel: skipping unsafe env line: %s\n' "$_key" >&2; continue;; esac
    eval "export $_line"                                    # allows $HOME-style expansion; command-substitution blocked above
  done < "$ENV_FILE"
  unset _line _key _isset
fi

TARGETS_JSON="$SENTINEL_HOME/config/targets.json"
VAR="$SENTINEL_HOME/var"
RUNS="$VAR/runs"; STATE="$VAR/state"; LOCKS="$VAR/locks"; REPORTS="$SENTINEL_HOME/reports"
mkdir -p "$RUNS" "$STATE" "$LOCKS" "$REPORTS"

# Defaults (mirror sentinel.env.example so the system works even with no env file).
: "${NTFY_SERVER:=https://ntfy.sh}"; : "${NTFY_TOPIC:=}"; : "${ENABLE_NOTIFY:=1}"; : "${NOTIFY_WEBHOOK_URL:=}"
: "${SCHEDULER_INTERVAL:=900}"
: "${RUN_WALL_TIMEOUT:=3600}"; : "${CMD_TIMEOUT:=900}"; : "${MAX_REVIEW_DIFF_CHARS:=40000}"
: "${REVIEW_ENGINE:=pi}"; : "${REVIEW_THINKING:=low}"; : "${REVIEW_LOOKBACK:=6}"; : "${REVIEW_TIMEOUT:=240}"; : "${CODEX_MODEL:=gpt-5.5}"; : "${ENABLE_REVIEW_PR_COMMENT:=0}"
: "${DOCS_ENGINE:=claude}"; : "${CLAUDE_PERMISSION_MODE:=acceptEdits}"; : "${ENABLE_DOCS_PR:=0}"
: "${BRAIN_PATH:=}"; : "${BRAIN_GITHUB:=Simbastack-hq/simbastack-brain}"; : "${BRAIN_BASE:=main}"; : "${ENABLE_BRAIN_PR:=0}"
: "${MAX_BRAIN_DIFF_CHARS:=80000}"; : "${BRAIN_MIN_DIFF_LINES:=8}"
: "${QA_PROVIDER:=xiaomi}"; : "${QA_MODEL:=mimo-v2.5-pro}"; : "${QA_THINKING:=medium}"; : "${QA_HEADLESS:=1}"; : "${QA_ENGINE:=node-loop}"
: "${DRY_RUN:=0}"

# NTFY_TOPIC comes from config/sentinel.env — Sentinel is fully self-contained.

TIMEOUT_BIN="$(command -v gtimeout || command -v timeout || true)"

c_red='\033[31m'; c_grn='\033[32m'; c_yel='\033[33m'; c_dim='\033[2m'; c_off='\033[0m'
die(){ printf "${c_red}sentinel: %s${c_off}\n" "$*" >&2; exit 1; }
log(){ printf "%s %s\n" "$(date '+%H:%M:%S')" "$*"; }
warn(){ printf "${c_yel}warn:${c_off} %s\n" "$*" >&2; }
ts(){ date +%Y%m%d-%H%M%S; }
have(){ command -v "$1" >/dev/null 2>&1; }
run_to(){ local t="$1"; shift
  if [ -n "$TIMEOUT_BIN" ]; then "$TIMEOUT_BIN" -k 10 "$t" "$@";
  else printf '\033[33msentinel: no timeout binary (brew install coreutils) — running WITHOUT a time cap: %s\033[0m\n' "$1" >&2; "$@"; fi; }

notify(){ # title body
  [ "${ENABLE_NOTIFY:-1}" = 1 ] || return 0
  [ -n "${NTFY_TOPIC:-}" ] || { log "(notify skipped: NTFY_TOPIC unset)"; return 0; }
  curl -fsS -H "Title: $1" -d "$2" "$NTFY_SERVER/$NTFY_TOPIC" >/dev/null 2>&1 || true
}

notify_webhook(){ # content — posts to NOTIFY_WEBHOOK_URL. Dual-key payload: Discord reads "content"
  # (ignores unknown fields), Slack incoming webhooks read "text" — one payload serves both.
  [ "${ENABLE_NOTIFY:-1}" = 1 ] || return 0
  [ -n "${NOTIFY_WEBHOOK_URL:-}" ] || return 0
  # Discord caps content at 2000 chars; truncate defensively for any webhook host.
  jq -n --arg c "${1:0:1900}" '{content:$c, text:$c}' | \
    curl -fsS -H 'Content-Type: application/json' -d @- "$NOTIFY_WEBHOOK_URL" >/dev/null 2>&1 || true
}

# ---- targets.json accessors ----
t_field(){ jq -r --arg k "$1" --arg f "$2" '.targets[$k][$f] // empty' "$TARGETS_JSON"; }
t_exists(){ [ -n "$(jq -r --arg k "$1" '.targets[$k] // empty' "$TARGETS_JSON" 2>/dev/null)" ]; }
t_keys(){ jq -r '.targets | keys[]' "$TARGETS_JSON" 2>/dev/null; }
t_agents(){ jq -r --arg k "$1" '.targets[$k].agents | keys[]?' "$TARGETS_JSON" 2>/dev/null; }
t_agent(){ jq -r --arg k "$1" --arg a "$2" --arg f "$3" '.targets[$k].agents[$a][$f] // empty' "$TARGETS_JSON"; }
t_agent_enabled(){ [ "$(jq -r --arg k "$1" --arg a "$2" '.targets[$k].agents[$a].enabled // false' "$TARGETS_JSON")" = "true" ]; }
t_app(){ jq -r --arg k "$1" --arg f "$2" '.targets[$k].agents.qa.app[$f] // empty' "$TARGETS_JSON"; }

# ---- per-(target,agent) state ----
state_file(){ echo "$STATE/${1}__${2}.json"; }
state_get(){ local f; f="$(state_file "$1" "$2")"; [ -f "$f" ] && jq -r --arg k "$3" '.[$k] // empty' "$f" 2>/dev/null || echo ""; }
state_set(){ # target agent k v [k v ...]
  local t="$1" a="$2"; shift 2; local f; f="$(state_file "$t" "$a")"
  [ -f "$f" ] || echo '{}' > "$f"
  # Pass BOTH key and value as jq --arg values (indexed k0/v0, k1/v1, …) so an arbitrary key string
  # is a data value, never spliced into the jq program. The old `.["$1"]=$$1` form used the key
  # verbatim as a jq VARIABLE NAME, so any key with a '-' (e.g. a date like 2026-07-22) compiled to
  # subtraction and the whole write silently failed — losing every key in the same call.
  local filter='.'; local -a args=(); local _i=0
  while [ $# -ge 2 ]; do
    args+=(--arg "k$_i" "$1" --arg "v$_i" "$2"); filter="$filter | .[\$k$_i]=\$v$_i"; _i=$((_i+1)); shift 2
  done
  local tmp; tmp="$(mktemp)"; jq "${args[@]}" "$filter" "$f" > "$tmp" && mv "$tmp" "$f" || { rm -f "$tmp"; return 1; }
}

# ---- run meta ----
meta_set(){ # run_dir k v [k v ...]
  local d="$1"; shift; local filter='.'; local -a args=()
  while [ $# -ge 2 ]; do filter="$filter | .[\"$1\"]=\$$1"; args+=(--arg "$1" "$2"); shift 2; done
  local tmp; tmp="$(mktemp)"; jq "${args[@]}" "$filter" "$d/meta.json" > "$tmp" && mv "$tmp" "$d/meta.json"
}

# ---- duration + cadence ----
dur_secs(){ # 900 | 30m | 6h | 1d
  local s="$1"; case "$s" in
    *s) echo "${s%s}";;
    *m) echo $(( ${s%m} * 60 ));;
    *h) echo $(( ${s%h} * 3600 ));;
    *d) echo $(( ${s%d} * 86400 ));;
    *) echo "$s";;
  esac
}
git_head(){ git -C "$1" rev-parse HEAD 2>/dev/null || echo ""; }
# cadence_due <target> <agent> <cadence> <repo_path> -> prints "yes <reason>" or "no <reason>"
cadence_due(){
  local t="$1" a="$2" cad="$3" path="$4" now last head
  now="$(date +%s)"
  case "$cad" in
    on-commit)
      [ -d "$path/.git" ] || { echo "no not-a-git-repo"; return; }
      head="$(git_head "$path")"; last="$(state_get "$t" "$a" lastRunSha)"
      if [ -z "$last" ]; then echo "yes first-run"; elif [ "$head" != "$last" ]; then echo "yes new-commit:${head:0:7}"; else echo "no same-commit"; fi ;;
    every:*)
      local d; d="$(dur_secs "${cad#every:}")"; last="$(state_get "$t" "$a" lastRunEpoch)"
      if [ -z "$last" ]; then echo "yes first-run"; elif [ $(( now - last )) -ge "$d" ]; then echo "yes due:$(( (now-last)/60 ))m-ago"; else echo "no next-in:$(( (d-(now-last))/60 ))m"; fi ;;
    *) echo "no bad-cadence:$cad" ;;
  esac
}

# ---- single-flight lock (mkdir is atomic) ----
lock_acquire(){ # name -> 0 if acquired
  local d="$LOCKS/$1.lock"
  if mkdir "$d" 2>/dev/null; then echo $$ > "$d/pid"; date +%s > "$d/epoch"; return 0; fi
  local lpid lepoch age maxage; lpid="$(cat "$d/pid" 2>/dev/null || true)"; lepoch="$(cat "$d/epoch" 2>/dev/null || echo 0)"
  age=$(( $(date +%s) - lepoch )); maxage=$(( RUN_WALL_TIMEOUT * 2 + 120 ))
  # Hold the lock only if the owner is alive AND the lock isn't absurdly old (guards against PID reuse).
  if [ -n "$lpid" ] && kill -0 "$lpid" 2>/dev/null && [ "$age" -lt "$maxage" ]; then return 1; fi
  rm -rf "$d"; mkdir "$d" 2>/dev/null && { echo $$ > "$d/pid"; date +%s > "$d/epoch"; return 0; }; return 1
}
lock_release(){ rm -rf "$LOCKS/$1.lock"; }

mask(){ sed -E 's/(TOKEN|TOPIC|KEY|SECRET|PASSWORD)=[^ ]*/\1=***/g'; }
