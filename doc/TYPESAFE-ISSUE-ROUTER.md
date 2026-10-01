# TypeSafe Issue Router

Automatic routing of new, unassigned issues to an agent. The decision comes
from TypeSafe's Jev model ([docs](https://docs.typesafe.ai)); Paperclip code
owns the policy and every outcome is recorded in the issue's activity.

## Turning it on

Routing is off unless both values are set in the instance env file
(`~/.paperclip/instances/<instance>/.env`) or the server environment:

```sh
PAPERCLIP_ISSUE_ROUTER=typesafe
TYPESAFE_API_KEY=...            # never commit this
# optional
TYPESAFE_MODEL=jev-latest       # pin a version (e.g. jev-1.13.0) once thresholds are tuned
PAPERCLIP_ISSUE_ROUTER_MIN_CONFIDENCE=0.5
```

Restart the server afterwards (`paperclipai service restart`). A
`TYPESAFE_API_KEY` set for other tools does not enable routing on its own.

## Which issues are routed

Issues created through `POST /api/companies/:companyId/issues` with no agent or
user assignee, `originKind` `manual`, not closed, not hidden, and not a
conversation. Onboarding first tasks, deduplicated creates, system-originated
issues (routines, watchdogs, task bridges), and child issues created through
`POST /api/issues/:id/children` are left alone. Creation never waits on routing.

## How the decision is made

One TypeSafe System One request, with the task (title, description, priority,
project, goal, parent title) as state:

| Question | Type | Meaning |
| --- | --- | --- |
| `owner` | Choice | Which eligible agent should own the task, or `no_suitable_agent` |
| `human_only` | Noul | Whether only a person can do the work |
| `fit:<agent>` | Noul, one per agent | Whether that agent is a suitable owner |

Eligible agents are those `getAgentWorkEligibility` marks assignable and
invokable (not terminated, pending approval, paused, or on a broken org chain),
described by name, title, role, capabilities, and manager.

The issue is assigned only when all of these hold:

1. `human_only` < 0.5
2. the owner pick is an agent, not `no_suitable_agent`
3. the owner pick's confidence ≥ `PAPERCLIP_ISSUE_ROUTER_MIN_CONFIDENCE`
4. that agent's `fit` ≥ 0.5
5. the issue's creator holds `tasks:assign` for that agent and the assignment
   creates no delegation cycle
6. the issue is still unassigned and open when the answer arrives

On assignment, a status that defaulted to `backlog` only because the issue had
no assignee moves to `todo`, and the agent is woken. An explicitly chosen
status is kept.

## What gets recorded

- `issue.auto_routed`: model, confidence, fit, `human_only`, the chosen agent,
  the top three alternatives with their fit, and any status change.
- `issue.auto_route_held`: the reason (`human_only`, `no_suitable_agent`,
  `low_confidence`, `poor_fit`, `creator_cannot_assign`, `no_candidates`,
  `too_many_candidates`, `typesafe_error`, `assignment_rejected`) with the same
  scores when available.

The actor is `system` / `typesafe-router`.

## Installing this repository

`paperclipai install --ref` builds a branch from GitHub. This repository also
fixes that path (it now stages `server/ui-dist` and package skills, and packs
staged bundled packages with `--ignore-scripts`), so an installed CLI from this
repository can update itself:

```sh
paperclipai install --repo tbmsindemnify/paperclip-jev --ref main --yes
paperclipai service restart
```

A CLI from upstream releases up to `2026.1001.0-canary.4` cannot install git
refs; run this repository's CLI from a checkout once instead
(`pnpm install && pnpm paperclipai install --repo tbmsindemnify/paperclip-jev --ref main --yes`).
Building from source needs Node 24.11+, Rust 1.97.1 (pinned by
`packages/paperclip-runner/runner/rust-toolchain.toml`), cmake, and a C compiler.

## Code

- `server/src/services/typesafe-issue-router.ts` — config, request building,
  decision policy, HTTP client, and the routing flow
- `server/src/services/typesafe-issue-router.test.ts` — unit tests
- `server/src/routes/issues.ts` — the call after issue creation
