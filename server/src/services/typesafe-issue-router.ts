import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, goals, issues, projects } from "@paperclipai/db";
import { getAgentWorkEligibility } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity, type LogActivityInput } from "./activity-log.js";
import {
  queueIssueAssignmentWakeup,
  type IssueAssignmentWakeupDeps,
} from "./issue-assignment-wakeup.js";
import type { issueService } from "./issues.js";

// Automatic routing of new, unassigned issues to an agent, decided by a
// TypeSafe System One model (Jev). One request asks, in parallel:
//   - owner: a Choice over every eligible agent plus "no suitable agent"
//   - human_only: a Noul for work only a person can do
//   - fit:<agent>: one Noul per agent, "is this agent a suitable owner?"
// Code owns the policy: the issue is assigned only when the owner pick is
// confident, its fit check passes, and the work is not human-only. Every
// other outcome leaves the issue unassigned and records why.
// Docs: https://docs.typesafe.ai/patterns/intent-routing

export const NO_SUITABLE_AGENT = "no_suitable_agent";
export const ROUTER_ACTOR_ID = "typesafe-router";

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_MIN_CONFIDENCE = 0.5;
const MIN_FIT = 0.5;
const MAX_HUMAN_ONLY = 0.5;
// A Choice accepts up to 255 options; well before that the per-agent fit
// questions dominate the request, so very large rosters are left to people.
const MAX_CANDIDATES = 100;
// Jev loses accuracy on large state full of unrelated detail.
const MAX_DESCRIPTION_CHARS = 4000;
const MAX_CAPABILITIES_CHARS = 600;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;

export type TypeSafeIssueRouterConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  minConfidence: number;
};

function readUnitInterval(raw: string | undefined, fallback: number) {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

/**
 * Routing is opt-in: PAPERCLIP_ISSUE_ROUTER=typesafe plus TYPESAFE_API_KEY.
 * A TypeSafe key present for other tools must not change task assignment.
 */
export function readTypeSafeIssueRouterConfig(
  env: NodeJS.ProcessEnv = process.env,
): TypeSafeIssueRouterConfig | null {
  if (env.PAPERCLIP_ISSUE_ROUTER?.trim().toLowerCase() !== "typesafe") return null;
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) {
    logger.warn(
      "PAPERCLIP_ISSUE_ROUTER=typesafe is set but TYPESAFE_API_KEY is empty; automatic issue routing is off",
    );
    return null;
  }
  return {
    apiKey,
    baseUrl: (env.TYPESAFE_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: env.TYPESAFE_MODEL?.trim() || DEFAULT_MODEL,
    minConfidence: readUnitInterval(
      env.PAPERCLIP_ISSUE_ROUTER_MIN_CONFIDENCE,
      DEFAULT_MIN_CONFIDENCE,
    ),
  };
}

export type RouterCandidate = {
  id: string;
  name: string;
  role: string;
  title: string | null;
  capabilities: string | null;
  reportsToName: string | null;
};

export type RouterTask = {
  title: string;
  description: string | null;
  priority: string;
  projectName: string | null;
  goalTitle: string | null;
  parentTitle: string | null;
};

type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
type NoulAnswer = { type: "noul"; noul: number };
export type SystemOneResponse = {
  model: string;
  answers: Record<string, ChoiceAnswer | NoulAnswer | { type: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

function truncate(text: string | null, max: number) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function withoutNulls(record: Record<string, string | null>) {
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, string] => entry[1] !== null),
  );
}

// Choice option names are sent to the model, so keys are readable agent-name
// slugs (unique, never colliding with the no-match option), not UUIDs.
export function buildOptionKeys(candidates: RouterCandidate[]) {
  const used = new Set<string>([NO_SUITABLE_AGENT]);
  return candidates.map((candidate) => {
    const base =
      candidate.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") || "agent";
    let key = base;
    for (let n = 2; used.has(key); n += 1) key = `${base}_${n}`;
    used.add(key);
    return key;
  });
}

function describeCandidate(candidate: RouterCandidate) {
  return withoutNulls({
    name: candidate.name,
    title: candidate.title,
    role: candidate.role,
    capabilities: truncate(candidate.capabilities, MAX_CAPABILITIES_CHARS),
    reports_to: candidate.reportsToName,
  });
}

export function buildRoutingRequest(
  task: RouterTask,
  candidates: RouterCandidate[],
  model: string,
) {
  const keys = buildOptionKeys(candidates);
  const keyToAgentId = new Map(keys.map((key, index) => [key, candidates[index]!.id]));
  const ownerCriteria: Record<string, unknown> = {};
  const questions: Record<string, unknown> = {};
  keys.forEach((key, index) => {
    const description = describeCandidate(candidates[index]!);
    ownerCriteria[key] = description;
    questions[`fit:${key}`] = {
      type: "noul",
      instructions: {
        candidate: description,
        question:
          "Is `candidate` a suitable owner for the task in `task`, given the candidate's role and capabilities?",
      },
    };
  });
  ownerCriteria[NO_SUITABLE_AGENT] =
    "None of the listed agents' roles or capabilities cover the work this task asks for; a person should choose the owner.";
  questions.owner = {
    type: "choice",
    instructions:
      "Which agent should own the task in `task`? Choose the agent whose role and capabilities best match the work the task asks for. Choose no_suitable_agent if no agent's role or capabilities cover that work.",
    criteria: ownerCriteria,
  };
  questions.human_only = {
    type: "noul",
    instructions:
      "Can the task in `task` only be done by a person, rather than by an AI agent working with software tools? Examples: it needs a handwritten signature, a payment with the requester's own card, being physically present somewhere, or a personal decision only the requester can make.",
    criteria: {
      true: "Only a person can do this task",
      false: "An AI agent working with software tools could do this task",
    },
  };
  const state = {
    task: withoutNulls({
      title: task.title,
      description: truncate(task.description, MAX_DESCRIPTION_CHARS),
      priority: task.priority,
      project: task.projectName,
      goal: task.goalTitle,
      parent_task: task.parentTitle,
    }),
  };
  return { body: { model, state, questions }, keyToAgentId };
}

export type HoldReason =
  | "no_candidates"
  | "too_many_candidates"
  | "typesafe_error"
  | "human_only"
  | "no_suitable_agent"
  | "low_confidence"
  | "poor_fit"
  | "creator_cannot_assign"
  | "assignment_rejected";

export type RouteAlternative = {
  agentId: string | null;
  optionKey: string;
  probability: number;
  fit: number | null;
};

export type RoutingDecision = {
  outcome: "assign" | "hold";
  reason: HoldReason | null;
  agentId: string | null;
  optionKey: string;
  confidence: number;
  fit: number | null;
  humanOnly: number;
  alternatives: RouteAlternative[];
};

function choiceAnswer(response: SystemOneResponse, id: string): ChoiceAnswer {
  const answer = response.answers[id];
  if (answer?.type !== "choice") throw new Error(`TypeSafe response is missing choice answer '${id}'`);
  return answer as ChoiceAnswer;
}

function noulAnswer(response: SystemOneResponse, id: string): number | null {
  const answer = response.answers[id];
  return answer?.type === "noul" ? (answer as NoulAnswer).noul : null;
}

export function decideRoute(
  response: SystemOneResponse,
  keyToAgentId: Map<string, string>,
  minConfidence: number,
): RoutingDecision {
  const owner = choiceAnswer(response, "owner");
  const humanOnly = noulAnswer(response, "human_only");
  if (humanOnly === null) throw new Error("TypeSafe response is missing noul answer 'human_only'");
  const fitFor = (key: string) => noulAnswer(response, `fit:${key}`);
  const alternatives = Object.entries(owner.probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([optionKey, probability]) => ({
      agentId: keyToAgentId.get(optionKey) ?? null,
      optionKey,
      probability,
      fit: fitFor(optionKey),
    }));
  const agentId = keyToAgentId.get(owner.choice) ?? null;
  const fit = agentId ? fitFor(owner.choice) : null;
  const base = {
    agentId,
    optionKey: owner.choice,
    confidence: owner.confidence,
    fit,
    humanOnly,
    alternatives,
  };
  const hold = (reason: HoldReason): RoutingDecision => ({ ...base, outcome: "hold", reason });

  if (humanOnly >= MAX_HUMAN_ONLY) return hold("human_only");
  if (owner.choice === NO_SUITABLE_AGENT || !agentId) return hold("no_suitable_agent");
  if (owner.confidence < minConfidence) return hold("low_confidence");
  if (fit === null || fit < MIN_FIT) return hold("poor_fit");
  return { ...base, outcome: "assign", reason: null };
}

export class TypeSafeRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "TypeSafeRequestError";
  }
}

function retryDelayMs(response: Response | null, attempt: number) {
  const retryAfter = Number(response?.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 5000);
  return 500 * 2 ** attempt;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callSystemOne(
  config: TypeSafeIssueRouterConfig,
  body: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<SystemOneResponse> {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(`${config.baseUrl}/v1/systemone`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await sleep(retryDelayMs(null, attempt));
        continue;
      }
      throw new TypeSafeRequestError(
        `TypeSafe request failed: ${err instanceof Error ? err.message : String(err)}`,
        null,
      );
    }
    // 429 rate limited, 529 overloaded: retry with backoff per the API docs.
    const retryable = response.status === 429 || response.status === 529 || response.status >= 500;
    if (retryable && attempt < MAX_RETRIES) {
      await sleep(retryDelayMs(response, attempt));
      continue;
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new TypeSafeRequestError(
        `TypeSafe request failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
        response.status,
      );
    }
    return (await response.json()) as SystemOneResponse;
  }
}

type RoutableIssue = {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  projectId: string | null;
  goalId: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  originKind: string;
  conversationAgentId: string | null;
  hiddenAt: Date | null;
};

function unroutableReason(issue: RoutableIssue, companyId: string) {
  if (issue.companyId !== companyId) return "company_mismatch";
  if (issue.assigneeAgentId || issue.assigneeUserId) return "already_assigned";
  // System-originated issues (routines, watchdogs, task bridges, onboarding)
  // already have their own assignment flows.
  if (issue.originKind !== "manual") return "system_origin";
  if (issue.status === "done" || issue.status === "cancelled") return "closed";
  if (issue.conversationAgentId) return "conversation";
  if (issue.hiddenAt) return "hidden";
  return null;
}

async function loadIssueFromDb(db: Db, issueId: string): Promise<RoutableIssue | null> {
  const rows = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      title: issues.title,
      description: issues.description,
      status: issues.status,
      priority: issues.priority,
      projectId: issues.projectId,
      goalId: issues.goalId,
      parentId: issues.parentId,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      originKind: issues.originKind,
      conversationAgentId: issues.conversationAgentId,
      hiddenAt: issues.hiddenAt,
    })
    .from(issues)
    .where(eq(issues.id, issueId));
  return rows[0] ?? null;
}

async function loadCandidatesFromDb(db: Db, companyId: string): Promise<RouterCandidate[]> {
  const rows = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      role: agents.role,
      title: agents.title,
      capabilities: agents.capabilities,
      status: agents.status,
      reportsTo: agents.reportsTo,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  const nameById = new Map(rows.map((row) => [row.id, row.name]));
  return rows
    .filter((row) => {
      // Assignable (lifecycle and org chain allow work) and invokable (not
      // paused), so a routed issue is one the agent can actually run.
      const eligibility = getAgentWorkEligibility({ agent: row, agents: rows });
      return eligibility.assignable && eligibility.invokable;
    })
    .map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role,
      title: row.title,
      capabilities: row.capabilities,
      reportsToName: row.reportsTo ? (nameById.get(row.reportsTo) ?? null) : null,
    }));
}

async function loadTaskFromDb(db: Db, issue: RoutableIssue): Promise<RouterTask> {
  const [project, goal, parent] = await Promise.all([
    issue.projectId
      ? db.select({ name: projects.name }).from(projects).where(eq(projects.id, issue.projectId)).then((rows) => rows[0] ?? null)
      : null,
    issue.goalId
      ? db.select({ title: goals.title }).from(goals).where(eq(goals.id, issue.goalId)).then((rows) => rows[0] ?? null)
      : null,
    issue.parentId
      ? db.select({ title: issues.title }).from(issues).where(eq(issues.id, issue.parentId)).then((rows) => rows[0] ?? null)
      : null,
  ]);
  return {
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    projectName: project?.name ?? null,
    goalTitle: goal?.title ?? null,
    parentTitle: parent?.title ?? null,
  };
}

export type RouteNewIssueInput = {
  issueId: string;
  companyId: string;
  /** True when the create request omitted status and it defaulted to backlog
   * only because the issue had no assignee. Routing then moves it to todo,
   * matching an issue created with that assignee. */
  statusWasDefaulted: boolean;
  /** Whether the issue's creator may assign it to this agent (tasks:assign).
   * Routing never assigns beyond what the creator could have done. */
  canAssign: (agentId: string) => Promise<boolean>;
};

export type RouteNewIssueResult =
  | { outcome: "disabled" }
  | { outcome: "skipped"; reason: string }
  | { outcome: "held"; reason: HoldReason }
  | { outcome: "assigned"; agentId: string };

export type TypeSafeIssueRouterDeps = {
  db: Db;
  config: TypeSafeIssueRouterConfig | null;
  issues: Pick<ReturnType<typeof issueService>, "update">;
  heartbeat: IssueAssignmentWakeupDeps;
  fetch?: typeof fetch;
  loadIssue?: (issueId: string) => Promise<RoutableIssue | null>;
  loadCandidates?: (companyId: string) => Promise<RouterCandidate[]>;
  loadTask?: (issue: RoutableIssue) => Promise<RouterTask>;
  logActivity?: (input: LogActivityInput) => Promise<unknown>;
};

function round(value: number | null) {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

export function createTypeSafeIssueRouter(deps: TypeSafeIssueRouterDeps) {
  const loadIssue = deps.loadIssue ?? ((issueId) => loadIssueFromDb(deps.db, issueId));
  const loadCandidates =
    deps.loadCandidates ?? ((companyId) => loadCandidatesFromDb(deps.db, companyId));
  const loadTask = deps.loadTask ?? ((issue) => loadTaskFromDb(deps.db, issue));
  const recordActivity = deps.logActivity ?? ((input) => logActivity(deps.db, input));

  async function hold(
    issue: RoutableIssue,
    reason: HoldReason,
    details: Record<string, unknown> = {},
  ): Promise<RouteNewIssueResult> {
    await recordActivity({
      companyId: issue.companyId,
      actorType: "system",
      actorId: ROUTER_ACTOR_ID,
      action: "issue.auto_route_held",
      entityType: "issue",
      entityId: issue.id,
      details: { identifier: issue.identifier, router: "typesafe", reason, ...details },
    });
    return { outcome: "held", reason };
  }

  async function routeNewIssue(input: RouteNewIssueInput): Promise<RouteNewIssueResult> {
    const config = deps.config;
    if (!config) return { outcome: "disabled" };
    const issue = await loadIssue(input.issueId);
    if (!issue) return { outcome: "skipped", reason: "not_found" };
    const skipReason = unroutableReason(issue, input.companyId);
    if (skipReason) return { outcome: "skipped", reason: skipReason };

    const candidates = await loadCandidates(issue.companyId);
    if (candidates.length === 0) return hold(issue, "no_candidates");
    if (candidates.length > MAX_CANDIDATES) {
      return hold(issue, "too_many_candidates", { candidateCount: candidates.length });
    }

    const nameById = new Map(candidates.map((candidate) => [candidate.id, candidate.name]));
    const { body, keyToAgentId } = buildRoutingRequest(
      await loadTask(issue),
      candidates,
      config.model,
    );
    let response: SystemOneResponse;
    let decision: RoutingDecision;
    try {
      response = await callSystemOne(config, body, deps.fetch);
      decision = decideRoute(response, keyToAgentId, config.minConfidence);
    } catch (err) {
      logger.warn({ err, issueId: issue.id }, "TypeSafe issue routing failed");
      return hold(issue, "typesafe_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const details = {
      // Activity redaction masks dotted, JWT-shaped strings such as
      // "jev-1.13.0"; the suffix keeps the versioned model ID readable.
      model: `${response.model} (TypeSafe)`,
      candidateCount: candidates.length,
      agentId: decision.agentId,
      agentName: decision.agentId ? (nameById.get(decision.agentId) ?? null) : null,
      confidence: round(decision.confidence),
      fit: round(decision.fit),
      humanOnly: round(decision.humanOnly),
      minConfidence: config.minConfidence,
      alternatives: decision.alternatives.map((alternative) => ({
        agentId: alternative.agentId,
        agentName: alternative.agentId ? (nameById.get(alternative.agentId) ?? null) : null,
        probability: round(alternative.probability),
        fit: round(alternative.fit),
      })),
    };
    if (decision.outcome === "hold") return hold(issue, decision.reason!, details);

    const agentId = decision.agentId!;
    if (!(await input.canAssign(agentId))) return hold(issue, "creator_cannot_assign", details);

    // The issue may have been assigned or closed while the model was deciding.
    const current = await loadIssue(issue.id);
    if (!current) return { outcome: "skipped", reason: "not_found" };
    const changedReason = unroutableReason(current, input.companyId);
    if (changedReason) return { outcome: "skipped", reason: changedReason };

    const moveToTodo = input.statusWasDefaulted && current.status === "backlog";
    let updated: Awaited<ReturnType<typeof deps.issues.update>>;
    try {
      updated = await deps.issues.update(current.id, {
        assigneeAgentId: agentId,
        ...(moveToTodo ? { status: "todo" } : {}),
        companyGuard: current.companyId,
      });
    } catch (err) {
      logger.warn({ err, issueId: current.id, agentId }, "TypeSafe-routed assignment was rejected");
      return hold(current, "assignment_rejected", {
        ...details,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!updated) return { outcome: "skipped", reason: "not_found" };

    await recordActivity({
      companyId: current.companyId,
      actorType: "system",
      actorId: ROUTER_ACTOR_ID,
      action: "issue.auto_routed",
      entityType: "issue",
      entityId: current.id,
      details: {
        identifier: current.identifier,
        router: "typesafe",
        ...details,
        statusChanged: moveToTodo ? { from: "backlog", to: "todo" } : null,
      },
    });
    void queueIssueAssignmentWakeup({
      heartbeat: deps.heartbeat,
      issue: {
        id: current.id,
        assigneeAgentId: agentId,
        status: moveToTodo ? "todo" : current.status,
      },
      reason: "issue_assigned",
      mutation: "auto_route",
      contextSource: "issue.auto_route",
      requestedByActorType: "system",
      requestedByActorId: ROUTER_ACTOR_ID,
    });
    return { outcome: "assigned", agentId };
  }

  return { enabled: deps.config !== null, routeNewIssue };
}

export type TypeSafeIssueRouter = ReturnType<typeof createTypeSafeIssueRouter>;
