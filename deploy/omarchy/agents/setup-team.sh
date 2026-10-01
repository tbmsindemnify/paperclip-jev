#!/usr/bin/env bash
# Create the TBM agent team in a local Paperclip instance from team.json:
# company, the shared tbm-vault skill, a project whose workspace is the vault,
# and one agent per entry, each checked with the adapter environment test.
#
#   VAULT="$HOME/path/to/TBM Knowledge Hub" ./setup-team.sh
#
# Refuses to run if the company already exists. Creates no issues and starts no
# runs; agents only work when a task is assigned to them.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
API="${PAPERCLIP_API:-http://127.0.0.1:3100/api}"
ORIGIN="${PAPERCLIP_ORIGIN:-${API%/api}}"
: "${VAULT:?Set VAULT to the vault directory}"
[ -f "$VAULT/AGENTS.md" ] || { echo "No AGENTS.md in $VAULT" >&2; exit 1; }
TEAM="$HERE/team.json"

call() { # method path [json]
  local out
  out=$(curl -sS -X "$1" -H "content-type: application/json" -H "origin: $ORIGIN" \
    "$API$2" ${3:+-d "$3"} -w $'\n%{http_code}')
  local code=${out##*$'\n'} body=${out%$'\n'*}
  if [ "${code:0:1}" != 2 ]; then echo "$1 $2 -> HTTP $code: $body" >&2; return 1; fi
  printf '%s' "$body"
}

company_name=$(jq -r .company.name "$TEAM")
if call GET /companies | jq -e --arg n "$company_name" '(. // [] | if type == "array" then . else (.items // []) end) | any(.name == $n)' >/dev/null; then
  echo "Company '$company_name' already exists; nothing changed." >&2
  exit 1
fi

CID=$(call POST /companies "$(jq -c '.company' "$TEAM")" | jq -r .id)
echo "company   $company_name  $CID"

skill_md=$(sed "s|{{VAULT}}|$VAULT|g" "$HERE/$(jq -r .skill.file "$TEAM")")
skill=$(call POST "/companies/$CID/skills" "$(jq -c --arg md "$skill_md" '.skill | {name, slug: .name, description, markdown: $md}' "$TEAM")")
SKILL_KEY=$(jq -r '.key // .slug // .name' <<<"$skill")
echo "skill     $SKILL_KEY"

project=$(call POST "/companies/$CID/projects" "$(jq -c --arg cwd "$VAULT" \
  '.project + {status: "in_progress", workspace: {name: "TBM Knowledge Hub", cwd: $cwd, isPrimary: true}}' "$TEAM")")
echo "project   $(jq -r .name <<<"$project")  $(jq -r .id <<<"$project")"

count=$(jq '.agents | length' "$TEAM")
for i in $(seq 0 $((count - 1))); do
  agent=$(jq -c ".agents[$i]" "$TEAM")
  instructions=$(cat "$HERE/$(jq -r .file <<<"$agent")")
  body=$(jq -c --arg cwd "$VAULT" --arg md "$instructions" --arg skill "$SKILL_KEY" '{
      name, role, title, capabilities, adapterType,
      adapterConfig: (.adapterConfig + {cwd: $cwd}),
      instructionsBundle: {entryFile: "AGENTS.md", files: {"AGENTS.md": $md}},
      desiredSkills: [$skill]
    }' <<<"$agent")
  created=$(call POST "/companies/$CID/agents" "$body")
  AID=$(jq -r .id <<<"$created")
  printf 'agent     %-14s %-12s %-16s %s\n' "$(jq -r .name <<<"$agent")" "$(jq -r .adapterType <<<"$agent")" \
    "$(jq -r .adapterConfig.model <<<"$agent")" "$(jq -r .status <<<"$created")"
  test=$(call POST "/companies/$CID/adapters/$(jq -r .adapterType <<<"$agent")/test-environment" \
    "$(jq -c --arg id "$AID" --arg cwd "$VAULT" '{agentId: $id, adapterConfig: (.adapterConfig + {cwd: $cwd})}' <<<"$agent")" || true)
  jq -r '"          environment: \(.status // .result.status // "unknown")" ,
         ((.checks // .result.checks // [])[] | select(.level != "info") | "            - \(.level): \(.message)")' <<<"$test" 2>/dev/null || echo "          environment test: $test"
done
