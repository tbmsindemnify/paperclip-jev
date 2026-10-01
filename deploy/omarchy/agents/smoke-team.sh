#!/usr/bin/env bash
# Read-only checks for the TBM team: one setup-check task per agent (runs the
# real model in the vault) plus a Jev routing check on backlog tasks that are
# deleted afterwards. Changes no vault files.
#   VAULT="$HOME/path/to/TBM Knowledge Hub" ./smoke-team.sh
set -uo pipefail
: "${VAULT:?Set VAULT to the vault directory}"
API=http://127.0.0.1:3100/api
H=(-H "content-type: application/json" -H "origin: http://127.0.0.1:3100")
call() { curl -sS -X "$1" "${H[@]}" "$API$2" ${3:+-d "$3"}; }
CID=$(call GET /companies | jq -r '(if type=="array" then . else .items end)[] | select(.name=="TBM Public Adjusters") | .id')
PID=$(call GET "/companies/$CID/projects" | jq -r '(if type=="array" then . else .items end)[] | select(.name=="TBM Knowledge Hub") | .id')
AGENTS=$(call GET "/companies/$CID/agents" | jq -c '[(if type=="array" then . else .items end)[] | {id, name}]')
echo "company $CID project $PID"

desc='Read-only setup check. Read AGENTS.md at the vault root and claims/_index.md. Reply in one short comment with: (1) the folders you may write to, (2) the command for searching claims, (3) the subject of the most recent commit in the vault git log. Do not create, edit or commit any files. Then mark this issue done.'
declare -A CHECK
for row in $(jq -r '.[] | @base64' <<<"$AGENTS"); do
  a=$(base64 -d <<<"$row"); aid=$(jq -r .id <<<"$a"); name=$(jq -r .name <<<"$a")
  iid=$(call POST "/companies/$CID/issues" "$(jq -nc --arg t "Setup check: $name reads the vault" --arg d "$desc" --arg a "$aid" --arg p "$PID" \
    '{title:$t, description:$d, assigneeAgentId:$a, projectId:$p, status:"todo"}')" | jq -r .id)
  CHECK[$name]=$iid; echo "setup check for $name: $iid"
done

echo "== Jev routing (backlog, no wakes)"
declare -a ROUTED
while IFS='|' read -r title expect; do
  iid=$(call POST "/companies/$CID/issues" "$(jq -nc --arg t "$title" --arg p "$PID" '{title:$t, projectId:$p, status:"backlog"}')" | jq -r .id)
  ROUTED+=("$iid|$title|$expect")
done <<'T'
File the new carrier letter for the Example roof claim and note what documents are still missing|Claims Desk
Double-check the supplement math and Texas compliance on the Example estimate before it goes to Tyler|Claims Review
Draft a first-touch email to a roofing contractor in Round Rock about referring hail claims|Growth
T
sleep 10
for r in "${ROUTED[@]}"; do
  IFS='|' read -r iid title expect <<<"$r"
  got=$(call GET "/issues/$iid" | jq -r .assigneeAgentId)
  gotname=$(jq -r --arg id "$got" '.[] | select(.id==$id) | .name' <<<"$AGENTS")
  act=$(call GET "/issues/$iid/activity" | jq -c '[(if type=="array" then . else .items end)[] | select(.action|startswith("issue.auto_route")) | {action, reason: .details.reason, confidence: .details.confidence, fit: .details.fit}] | .[0]')
  echo "  expected $expect -> ${gotname:-unassigned}  $act"
  call DELETE "/issues/$iid" >/dev/null && echo "    (test task deleted)"
done

echo "== waiting for setup checks (up to 8 min)"
for i in $(seq 1 48); do
  pending=0
  for name in "${!CHECK[@]}"; do
    st=$(call GET "/issues/${CHECK[$name]}" | jq -r .status)
    [ "$st" = done ] || [ "$st" = cancelled ] || [ "$st" = blocked ] || pending=$((pending+1))
  done
  [ $pending -eq 0 ] && break
  sleep 10
done
for name in "${!CHECK[@]}"; do
  iid=${CHECK[$name]}
  echo "---- $name: status $(call GET "/issues/$iid" | jq -r .status)"
  call GET "/issues/$iid/comments" | jq -r '(if type=="array" then . else .items end) | last | .body // "(no comment)"' | head -c 900; echo
done
cd "$VAULT" && echo "== vault after checks: $(git status --porcelain | wc -l) changed files; head $(git log --oneline -1)"
