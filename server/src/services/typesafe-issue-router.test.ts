import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  NO_SUITABLE_AGENT,
  buildOptionKeys,
  buildRoutingRequest,
  callSystemOne,
  createTypeSafeIssueRouter,
  decideRoute,
  readTypeSafeIssueRouterConfig,
  type RouterCandidate,
  type RouterTask,
  type SystemOneResponse,
  type TypeSafeIssueRouterConfig,
} from "./typesafe-issue-router.js";

const companyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const issueId = "11111111-1111-4111-8111-111111111111";
const engineerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const marketerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const config: TypeSafeIssueRouterConfig = {
  apiKey: "ts-test-key",
  baseUrl: "https://typesafe.test",
  model: "jev-latest",
  minConfidence: 0.5,
};

const candidates: RouterCandidate[] = [
  {
    id: engineerId,
    name: "Founding Engineer",
    role: "engineer",
    title: "Founding Engineer",
    capabilities: "Builds and fixes the web app and its API",
    reportsToName: "CEO",
  },
  {
    id: marketerId,
    name: "Growth Marketer",
    role: "marketing",
    title: null,
    capabilities: "Writes landing pages, emails, and social posts",
    reportsToName: "CEO",
  },
];

const task: RouterTask = {
  title: "Fix the broken signup button",
  description: "Clicking Sign up on the landing page does nothing.",
  priority: "high",
  projectName: "Web app",
  goalTitle: null,
  parentTitle: null,
};

function response(input: {
  choice: string;
  confidence: number;
  probabilities?: Record<string, number>;
  humanOnly?: number;
  fits?: Record<string, number>;
}): SystemOneResponse {
  const fits = input.fits ?? { founding_engineer: 0.9, growth_marketer: 0.1 };
  return {
    model: "jev-1.13.0",
    answers: {
      owner: {
        type: "choice",
        choice: input.choice,
        confidence: input.confidence,
        probabilities: input.probabilities ?? { [input.choice]: 1 },
      },
      human_only: { type: "noul", noul: input.humanOnly ?? 0.05 },
      ...Object.fromEntries(
        Object.entries(fits).map(([key, noul]) => [`fit:${key}`, { type: "noul", noul }]),
      ),
    },
  };
}

const keyToAgentId = new Map([
  ["founding_engineer", engineerId],
  ["growth_marketer", marketerId],
]);

describe("readTypeSafeIssueRouterConfig", () => {
  it("is off unless explicitly enabled", () => {
    expect(readTypeSafeIssueRouterConfig({})).toBeNull();
    expect(readTypeSafeIssueRouterConfig({ TYPESAFE_API_KEY: "key" })).toBeNull();
    expect(readTypeSafeIssueRouterConfig({ PAPERCLIP_ISSUE_ROUTER: "typesafe" })).toBeNull();
  });

  it("reads the key, defaults, and a valid confidence threshold", () => {
    expect(
      readTypeSafeIssueRouterConfig({
        PAPERCLIP_ISSUE_ROUTER: "TypeSafe",
        TYPESAFE_API_KEY: " key ",
        TYPESAFE_BASE_URL: "https://example.test/",
        PAPERCLIP_ISSUE_ROUTER_MIN_CONFIDENCE: "0.7",
      }),
    ).toEqual({
      apiKey: "key",
      baseUrl: "https://example.test",
      model: "jev-latest",
      minConfidence: 0.7,
    });
  });

  it("ignores an out-of-range confidence threshold", () => {
    const parsed = readTypeSafeIssueRouterConfig({
      PAPERCLIP_ISSUE_ROUTER: "typesafe",
      TYPESAFE_API_KEY: "key",
      PAPERCLIP_ISSUE_ROUTER_MIN_CONFIDENCE: "7",
    });
    expect(parsed?.minConfidence).toBe(0.5);
  });
});

describe("buildOptionKeys", () => {
  it("makes unique readable keys that never collide with the no-match option", () => {
    expect(
      buildOptionKeys([
        { ...candidates[0]!, name: "QA Lead" },
        { ...candidates[0]!, name: "qa lead" },
        { ...candidates[0]!, name: "No suitable agent" },
        { ...candidates[0]!, name: "!!!" },
      ]),
    ).toEqual(["qa_lead", "qa_lead_2", "no_suitable_agent_2", "agent"]);
  });
});

describe("buildRoutingRequest", () => {
  it("asks one owner choice, a human-only check, and a fit check per agent", () => {
    const { body, keyToAgentId: keys } = buildRoutingRequest(task, candidates, "jev-latest");
    expect(body.model).toBe("jev-latest");
    expect(Object.keys(body.questions).sort()).toEqual([
      "fit:founding_engineer",
      "fit:growth_marketer",
      "human_only",
      "owner",
    ]);
    const owner = body.questions.owner as { type: string; criteria: Record<string, unknown> };
    expect(owner.type).toBe("choice");
    expect(Object.keys(owner.criteria)).toEqual([
      "founding_engineer",
      "growth_marketer",
      NO_SUITABLE_AGENT,
    ]);
    expect(owner.criteria.growth_marketer).toEqual({
      name: "Growth Marketer",
      role: "marketing",
      capabilities: "Writes landing pages, emails, and social posts",
      reports_to: "CEO",
    });
    expect(body.state).toEqual({
      task: {
        title: "Fix the broken signup button",
        description: "Clicking Sign up on the landing page does nothing.",
        priority: "high",
        project: "Web app",
      },
    });
    expect(keys.get("founding_engineer")).toBe(engineerId);
  });

  it("truncates long descriptions", () => {
    const { body } = buildRoutingRequest(
      { ...task, description: "x".repeat(5000) },
      candidates,
      "jev-latest",
    );
    expect((body.state.task as { description: string }).description).toHaveLength(4001);
  });
});

describe("decideRoute", () => {
  it("assigns a confident pick whose fit check passes", () => {
    const decision = decideRoute(
      response({
        choice: "founding_engineer",
        confidence: 0.9,
        probabilities: { founding_engineer: 0.95, growth_marketer: 0.04, [NO_SUITABLE_AGENT]: 0.01 },
      }),
      keyToAgentId,
      0.5,
    );
    expect(decision).toMatchObject({ outcome: "assign", agentId: engineerId, fit: 0.9 });
    expect(decision.alternatives.map((alternative) => alternative.agentId)).toEqual([
      engineerId,
      marketerId,
      null,
    ]);
  });

  it.each([
    ["human_only", response({ choice: "founding_engineer", confidence: 0.9, humanOnly: 0.8 })],
    ["no_suitable_agent", response({ choice: NO_SUITABLE_AGENT, confidence: 0.9 })],
    ["low_confidence", response({ choice: "founding_engineer", confidence: 0.3 })],
    [
      "poor_fit",
      response({ choice: "growth_marketer", confidence: 0.9, fits: { growth_marketer: 0.2 } }),
    ],
  ])("holds for %s", (reason, answer) => {
    expect(decideRoute(answer, keyToAgentId, 0.5)).toMatchObject({ outcome: "hold", reason });
  });

  it("rejects a response without the owner answer", () => {
    expect(() => decideRoute({ model: "jev", answers: {} }, keyToAgentId, 0.5)).toThrow(
      /owner/,
    );
  });
});

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("callSystemOne", () => {
  it("posts to the System One endpoint with a bearer key", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { model: "jev", answers: {} }));
    await callSystemOne(config, { model: "jev-latest" }, fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://typesafe.test/v1/systemone");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ts-test-key");
  });

  it("retries a rate-limited request", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: "slow down" }, { "retry-after": "0.01" }))
      .mockResolvedValueOnce(jsonResponse(200, { model: "jev", answers: {} }));
    await expect(
      callSystemOne(config, {}, fetchImpl as unknown as typeof fetch),
    ).resolves.toEqual({ model: "jev", answers: {} });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails on an auth error without echoing the key", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: "invalid key" }));
    const error = await callSystemOne(config, {}, fetchImpl as unknown as typeof fetch).then(
      () => {
        throw new Error("expected callSystemOne to fail");
      },
      (err: unknown) => err as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("HTTP 401");
    expect(error.message).not.toContain("ts-test-key");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

type FakeIssue = NonNullable<
  Awaited<ReturnType<NonNullable<Parameters<typeof createTypeSafeIssueRouter>[0]["loadIssue"]>>>
>;

function unassignedIssue(overrides: Partial<FakeIssue> = {}): FakeIssue {
  return {
    id: issueId,
    companyId,
    identifier: "ACME-7",
    title: task.title,
    description: task.description,
    status: "backlog",
    priority: "high",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    originKind: "manual",
    conversationAgentId: null,
    hiddenAt: null,
    ...overrides,
  };
}

function harness(input: {
  issues?: FakeIssue[];
  answer?: SystemOneResponse | Error;
  candidates?: RouterCandidate[];
  routerConfig?: TypeSafeIssueRouterConfig | null;
}) {
  // Each load returns the next snapshot; the last one repeats.
  const issueSnapshots = [...(input.issues ?? [unassignedIssue()])];
  const loadIssue = vi.fn(async () =>
    issueSnapshots.length > 1 ? issueSnapshots.shift()! : (issueSnapshots[0] ?? null),
  );
  const update = vi.fn(async (id: string, data: Record<string, unknown>) => ({ id, ...data }));
  const wakeup = vi.fn(async () => null);
  const activity = vi.fn(async () => undefined);
  const answer = input.answer ?? response({ choice: "founding_engineer", confidence: 0.9 });
  const fetchImpl = vi.fn(async () =>
    answer instanceof Error ? jsonResponse(401, { error: answer.message }) : jsonResponse(200, answer),
  );
  const router = createTypeSafeIssueRouter({
    db: {} as Db,
    config: input.routerConfig === undefined ? config : input.routerConfig,
    issues: { update } as never,
    heartbeat: { wakeup },
    fetch: fetchImpl as unknown as typeof fetch,
    loadIssue,
    loadCandidates: async () => input.candidates ?? candidates,
    loadTask: async () => task,
    logActivity: activity,
  });
  return { router, update, wakeup, activity, fetchImpl };
}

const allowAll = async () => true;

describe("createTypeSafeIssueRouter", () => {
  it("does nothing when routing is disabled", async () => {
    const { router, fetchImpl } = harness({ routerConfig: null });
    expect(router.enabled).toBe(false);
    await expect(
      router.routeNewIssue({ issueId, companyId, statusWasDefaulted: true, canAssign: allowAll }),
    ).resolves.toEqual({ outcome: "disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("assigns, moves a defaulted backlog issue to todo, logs, and wakes the agent", async () => {
    const { router, update, wakeup, activity } = harness({});
    await expect(
      router.routeNewIssue({ issueId, companyId, statusWasDefaulted: true, canAssign: allowAll }),
    ).resolves.toEqual({ outcome: "assigned", agentId: engineerId });
    expect(update).toHaveBeenCalledWith(issueId, {
      assigneeAgentId: engineerId,
      status: "todo",
      companyGuard: companyId,
    });
    expect(activity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "issue.auto_routed",
        actorType: "system",
        actorId: "typesafe-router",
        details: expect.objectContaining({
          agentName: "Founding Engineer",
          model: "jev-1.13.0",
          statusChanged: { from: "backlog", to: "todo" },
        }),
      }),
    );
    expect(wakeup).toHaveBeenCalledWith(
      engineerId,
      expect.objectContaining({ source: "assignment", reason: "issue_assigned" }),
    );
  });

  it("keeps an explicitly chosen backlog status and does not wake", async () => {
    const { router, update, wakeup } = harness({});
    await router.routeNewIssue({ issueId, companyId, statusWasDefaulted: false, canAssign: allowAll });
    expect(update).toHaveBeenCalledWith(issueId, {
      assigneeAgentId: engineerId,
      companyGuard: companyId,
    });
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("holds when the creator may not assign to the chosen agent", async () => {
    const { router, update, activity } = harness({});
    await expect(
      router.routeNewIssue({
        issueId,
        companyId,
        statusWasDefaulted: true,
        canAssign: async () => false,
      }),
    ).resolves.toEqual({ outcome: "held", reason: "creator_cannot_assign" });
    expect(update).not.toHaveBeenCalled();
    expect(activity).toHaveBeenCalledWith(
      expect.objectContaining({ action: "issue.auto_route_held" }),
    );
  });

  it("skips an issue that was assigned while the model was deciding", async () => {
    const { router, update } = harness({
      issues: [unassignedIssue(), unassignedIssue({ assigneeUserId: "user-1" })],
    });
    await expect(
      router.routeNewIssue({ issueId, companyId, statusWasDefaulted: true, canAssign: allowAll }),
    ).resolves.toEqual({ outcome: "skipped", reason: "already_assigned" });
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    ["already_assigned", unassignedIssue({ assigneeAgentId: marketerId })],
    ["system_origin", unassignedIssue({ originKind: "routine_execution" })],
    ["closed", unassignedIssue({ status: "cancelled" })],
  ])("skips without calling TypeSafe: %s", async (reason, issue) => {
    const { router, fetchImpl, activity } = harness({ issues: [issue] });
    await expect(
      router.routeNewIssue({ issueId, companyId, statusWasDefaulted: true, canAssign: allowAll }),
    ).resolves.toEqual({ outcome: "skipped", reason });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
  });

  it("holds and records the error when TypeSafe fails", async () => {
    const { router, update, activity } = harness({ answer: new Error("invalid key") });
    await expect(
      router.routeNewIssue({ issueId, companyId, statusWasDefaulted: true, canAssign: allowAll }),
    ).resolves.toEqual({ outcome: "held", reason: "typesafe_error" });
    expect(update).not.toHaveBeenCalled();
    expect(activity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "issue.auto_route_held",
        details: expect.objectContaining({ reason: "typesafe_error" }),
      }),
    );
  });

  it("holds when the company has no eligible agents", async () => {
    const { router, fetchImpl } = harness({ candidates: [] });
    await expect(
      router.routeNewIssue({ issueId, companyId, statusWasDefaulted: true, canAssign: allowAll }),
    ).resolves.toEqual({ outcome: "held", reason: "no_candidates" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
