import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type { ThreadResponse } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import { createStore, registerTasksApi } from ".";

type ThreadOverrides = Partial<ThreadResponse>;

interface EvidenceFixture {
  threads?: Record<string, ThreadOverrides | Error>;
  queued?: Record<string, Array<Record<string, unknown>>>;
  turnModels?: Record<string, string | Error>;
  catalog?: Array<{ id: string; model: string; displayName: string }>;
}

function seedAgentHost(fixture: EvidenceFixture) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "tasks",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const entry = fixture.threads[threadId];
          if (entry instanceof Error) throw entry;
          return makeThreadResponse({
            id: threadId,
            ...(entry ?? {}),
          });
        },
        queuedMessages: {
          list: async ({ threadId }: { threadId: string }) =>
            fixture.queued[threadId] ?? [],
        },
        events: {
          list: async ({ threadId }: { threadId: string }) => {
            const model = fixture.turnModels[threadId];
            if (model instanceof Error) throw model;
            if (model === undefined) return [];
            return [
              {
                type: "client/turn/requested",
                data: { execution: { model } },
              },
            ];
          },
        },
      },
      providers: {
        models: async () => ({
          providers: [],
          models: fixture.catalog ?? [],
        }),
      },
    },
  });
  const store = createStore(bb);
  registerTasksApi(bb, store);
  return { bb, harness, store };
}

function seedTwoProjects(store: ReturnType<typeof createStore>) {
  const first = store.tasks.createProject({
    name: "Alpha",
    prefix: "ALP",
    color: "blue",
  });
  const second = store.tasks.createProject({
    name: "Beta",
    prefix: "BET",
    color: "green",
  });
  return { first, second };
}

const RUN_THREAD = "thr_run_agent";
const QUEUED_THREAD = "thr_queued_agent";
const IDLE_THREAD = "thr_idle_agent";
const STARTING_THREAD = "thr_starting_agent";
const STALE_THREAD = "thr_stale_agent";

/** Criterion-5 fixture: five counted records across three tasks, three of
 *  them under one task, with one positively running, one positively queued,
 *  and records whose fresh evidence shows starting or nothing at all. */
function seedCriterionFixture(overrides: EvidenceFixture = {}) {
  const fixture: EvidenceFixture = {
    threads: {
      [RUN_THREAD]: { status: "active" },
      [QUEUED_THREAD]: { status: "idle", queuedMessageCount: 1 },
      [IDLE_THREAD]: { status: "idle" },
      [STARTING_THREAD]: { status: "starting" },
      [STALE_THREAD]: { status: "pending" },
      ...overrides.threads,
    },
    queued: {
      [QUEUED_THREAD]: [
        { model: "glm-4.6", waitingOn: null, failureReason: null },
      ],
      ...overrides.queued,
    },
    turnModels: {
      [RUN_THREAD]: "claude-sonnet-5",
      [IDLE_THREAD]: "claude-sonnet-5",
      [STARTING_THREAD]: "claude-sonnet-5",
      ...overrides.turnModels,
    },
    catalog: [
      { id: "anthropic/claude-sonnet-5", model: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
      { id: "zai/glm-4.6", model: "glm-4.6", displayName: "GLM-4.6" },
      ...Array.from(overrides.catalog ?? []),
    ],
  };
  const { harness, store } = seedAgentHost(fixture);
  const { first, second } = seedTwoProjects(store);
  const shared = store.tasks.createTask({
    projectId: first.id,
    title: "Parent with three agents",
  });
  const solo = store.tasks.createTask({
    projectId: second.id,
    title: "Solo starting agent",
  });
  const staleTask = store.tasks.createTask({
    projectId: second.id,
    title: "Stale record",
  });
  for (const threadId of [RUN_THREAD, QUEUED_THREAD, IDLE_THREAD]) {
    store.tasks.upsertTaskThread({
      taskId: shared.id,
      threadId,
      presetName: "worker",
      title: threadId,
      liveStatus: "working",
    });
  }
  store.tasks.upsertTaskThread({
    taskId: solo.id,
    threadId: STARTING_THREAD,
    presetName: "worker",
    title: STARTING_THREAD,
    liveStatus: "starting",
  });
  store.tasks.upsertTaskThread({
    taskId: staleTask.id,
    threadId: STALE_THREAD,
    presetName: "worker",
    title: STALE_THREAD,
    liveStatus: "working",
  });
  return { harness, store, shared, solo, staleTask };
}

async function readAgents(harness: ReturnType<
  typeof createFakePluginHost
>["harness"]) {
  return harness.callRpc("activeAgents", null) as Promise<{
    agents: Array<{
      id: string;
      taskId: string;
      taskKey: string;
      threadId: string;
      state: string;
      detail: string | null;
      providerId: string | null;
      model: { id: string | null; displayName: string; evidence: string };
      blocker: { kind: string; detail: string | null } | null;
    }>;
    taskTotal: number;
    revision: string;
  }>;
}

describe("activeAgents projection", () => {
  it("counts every record and labels the page truthfully for the criterion-5 fixture", async () => {
    const { harness } = seedCriterionFixture();
    const snapshot = await readAgents(harness);
    expect(snapshot.agents).toHaveLength(5);
    expect(snapshot.taskTotal).toBe(3);
    const byTask = new Map<string, number>();
    for (const agent of snapshot.agents) {
      byTask.set(agent.taskId, (byTask.get(agent.taskId) ?? 0) + 1);
    }
    expect([...byTask.values()].sort((a, b) => b - a)).toEqual([3, 1, 1]);
    await harness.dispose();
  });

  it("classifies each counted record from fresh thread evidence only", async () => {
    const { harness } = seedCriterionFixture();
    const snapshot = await readAgents(harness);
    const byThread = new Map(
      snapshot.agents.map((agent) => [agent.threadId, agent]),
    );
    expect(byThread.get(RUN_THREAD)?.state).toBe("running");
    expect(byThread.get(QUEUED_THREAD)?.state).toBe("queued");
    expect(byThread.get(IDLE_THREAD)?.state).toBe("idle");
    expect(byThread.get(STARTING_THREAD)?.state).toBe("starting");
    expect(byThread.get(STALE_THREAD)?.state).toBe("stale");
    expect(byThread.get(STALE_THREAD)?.detail).toBe(
      "created but never dispatched",
    );
    await harness.dispose();
  });

  it("resolves running, queued, and last-used models from their own evidence, never from the provider", async () => {
    const { harness } = seedCriterionFixture();
    const snapshot = await readAgents(harness);
    const byThread = new Map(
      snapshot.agents.map((agent) => [agent.threadId, agent]),
    );
    expect(byThread.get(RUN_THREAD)?.model).toEqual({
      id: "claude-sonnet-5",
      displayName: "Claude Sonnet 5",
      evidence: "current-turn",
    });
    expect(byThread.get(RUN_THREAD)?.providerId).toBe("test-provider");
    // GLM queued behind a claude-code-provider thread still says GLM.
    expect(byThread.get(QUEUED_THREAD)?.model).toEqual({
      id: "glm-4.6",
      displayName: "GLM-4.6",
      evidence: "queued",
    });
    expect(byThread.get(IDLE_THREAD)?.model).toEqual({
      id: "claude-sonnet-5",
      displayName: "Claude Sonnet 5",
      evidence: "last-turn",
    });
    expect(byThread.get(STALE_THREAD)?.model).toEqual({
      id: null,
      displayName: "Model unknown",
      evidence: "none",
    });
    await harness.dispose();
  });

  it("keeps an unreadable thread visible as unknown with the failure detail", async () => {
    const { harness, store, shared } = seedCriterionFixture();
    store.tasks.upsertTaskThread({
      taskId: shared.id,
      threadId: "thr_unreadable",
      presetName: "worker",
      title: "thr_unreadable",
      liveStatus: "working",
    });
    harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
      if (threadId === "thr_unreadable") {
        throw new Error("thread store unavailable");
      }
      return makeThreadResponse({ id: threadId });
    });
    const snapshot = await readAgents(harness);
    expect(snapshot.agents).toHaveLength(6);
    const unreadable = snapshot.agents.find(
      (agent) => agent.threadId === "thr_unreadable",
    );
    expect(unreadable?.state).toBe("unknown");
    expect(unreadable?.detail).toContain("thread store unavailable");
    const stillClassified = snapshot.agents.find(
      (agent) => agent.threadId === IDLE_THREAD,
    );
    expect(stillClassified?.state).toBe("idle");
    await harness.dispose();
  });

  it("derives blockers only from positive evidence and never from ordinary waits", async () => {
    const { harness, store } = seedCriterionFixture({
      queued: {
        [QUEUED_THREAD]: [
          {
            model: "glm-4.6",
            waitingOn: { kind: "interaction" },
            failureReason: null,
          },
        ],
      },
    });
    const approvalTask = store.tasks.createTask({
      projectId: store.tasks
        .listProjects()
        .find((project) => project.prefix === "ALP")!.id,
      title: "Blocked agents",
    });
    for (const [threadId, waitingOn, failureReason] of [
      ["thr_wait_plugin", { kind: "plugin", pluginId: "verification", reason: "gates open" }, null],
      ["thr_wait_host", { kind: "host-offline", hostName: "build-box" }, null],
      ["thr_failed", null, "provider auth rejected the request"],
      ["thr_ordinary", { kind: "time" }, null],
      ["thr_behind_turn", { kind: "thread-busy" }, null],
    ] as const) {
      store.tasks.upsertTaskThread({
        taskId: approvalTask.id,
        threadId,
        presetName: "worker",
        title: threadId,
        liveStatus: "working",
      });
    }
    const extraThreads: Record<string, ThreadOverrides | Error> = {
      [QUEUED_THREAD]: { status: "idle", queuedMessageCount: 1 },
    };
    for (const threadId of [
      "thr_wait_plugin",
      "thr_wait_host",
      "thr_failed",
      "thr_ordinary",
      "thr_behind_turn",
    ]) {
      extraThreads[threadId] = { status: "idle", queuedMessageCount: 1 };
    }
    extraThreads["thr_errored"] = { status: "error" };
    store.tasks.upsertTaskThread({
      taskId: approvalTask.id,
      threadId: "thr_errored",
      presetName: "worker",
      title: "thr_errored",
      liveStatus: "working",
    });
    // Re-stub with the extra threads and rows.
    harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
      const overrides = extraThreads[threadId];
      if (overrides instanceof Error) throw overrides;
      return makeThreadResponse({ id: threadId, ...(overrides ?? {}) });
    });
    harness.sdk.stub(
      "threads.queuedMessages.list",
      async ({ threadId }: { threadId: string }) => {
        const rows: Array<Record<string, unknown>> = {
          [QUEUED_THREAD]: [
            {
              model: "glm-4.6",
              waitingOn: { kind: "interaction" },
              failureReason: null,
            },
          ],
          thr_wait_plugin: [
            {
              model: "glm-4.6",
              waitingOn: { kind: "plugin", pluginId: "verification", reason: "gates open" },
              failureReason: null,
            },
          ],
          thr_wait_host: [
            { model: "glm-4.6", waitingOn: { kind: "host-offline", hostName: "build-box" }, failureReason: null },
          ],
          thr_failed: [
            { model: "glm-4.6", waitingOn: null, failureReason: "provider auth rejected the request" },
          ],
          thr_ordinary: [{ model: "glm-4.6", waitingOn: { kind: "time" }, failureReason: null }],
          thr_behind_turn: [
            { model: "glm-4.6", waitingOn: { kind: "thread-busy" }, failureReason: null },
          ],
        };
        return rows[threadId] ?? [];
      },
    );
    const snapshot = await readAgents(harness);
    const byThread = new Map(
      snapshot.agents.map((agent) => [agent.threadId, agent]),
    );
    expect(byThread.get(QUEUED_THREAD)?.blocker).toEqual({
      kind: "interaction",
      detail: null,
    });
    expect(byThread.get("thr_wait_plugin")?.blocker).toEqual({
      kind: "plugin",
      detail: "verification: gates open",
    });
    expect(byThread.get("thr_wait_host")?.blocker).toEqual({
      kind: "host-offline",
      detail: "build-box",
    });
    expect(byThread.get("thr_failed")?.blocker).toEqual({
      kind: "failed-dispatch",
      detail: "provider auth rejected the request",
    });
    expect(byThread.get("thr_errored")?.blocker).toEqual({
      kind: "thread-error",
      detail: null,
    });
    expect(byThread.get("thr_ordinary")?.blocker).toBeNull();
    expect(byThread.get("thr_behind_turn")?.blocker).toBeNull();
    await harness.dispose();
  });

  it("changes the revision exactly when the visible truth changes", async () => {
    let queued = false;
    const { harness, store } = seedCriterionFixture();
    const task = store.tasks.createTask({
      projectId: store.tasks.listProjects()[0]!.id,
      title: "Revision task",
    });
    store.tasks.upsertTaskThread({
      taskId: task.id,
      threadId: "thr_revision",
      presetName: "worker",
      title: "thr_revision",
      liveStatus: "working",
    });
    harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({
        id: threadId,
        status: "idle",
        queuedMessageCount: queued ? 1 : 0,
      }),
    );
    const before = await readAgents(harness);
    const again = await readAgents(harness);
    expect(again.revision).toBe(before.revision);
    queued = true;
    const after = await readAgents(harness);
    expect(after.revision).not.toBe(before.revision);
    await harness.dispose();
  });

  it("prefers the current-turn model for a running thread over a queued follow-up on another model", async () => {
    const { harness } = seedCriterionFixture({
      queued: {
        [QUEUED_THREAD]: [
          { model: "glm-4.6", waitingOn: null, failureReason: null },
        ],
        [RUN_THREAD]: [
          { model: "glm-4.6", waitingOn: null, failureReason: null },
        ],
      },
    });
    const snapshot = await readAgents(harness);
    const running = snapshot.agents.find(
      (agent) => agent.threadId === RUN_THREAD,
    );
    expect(running?.state).toBe("running");
    expect(running?.model).toEqual({
      id: "claude-sonnet-5",
      displayName: "Claude Sonnet 5",
      evidence: "current-turn",
    });
    const queued = snapshot.agents.find(
      (agent) => agent.threadId === QUEUED_THREAD,
    );
    expect(queued?.model.evidence).toBe("queued");
    await harness.dispose();
  });

  it("labels a queued row's model as queued when a running thread has no readable turn request", async () => {
    const { harness } = seedCriterionFixture({
      threads: {
        [RUN_THREAD]: { status: "active", queuedMessageCount: 1 },
      },
      queued: {
        [RUN_THREAD]: [
          { model: "glm-4.6", waitingOn: null, failureReason: null },
        ],
      },
    });
    harness.sdk.stub(
      "threads.events.list",
      async ({ threadId }: { threadId: string }) =>
        threadId === RUN_THREAD
          ? []
          : [{ type: "client/turn/requested", data: { execution: { model: "claude-sonnet-5" } } }],
    );
    const snapshot = await readAgents(harness);
    const running = snapshot.agents.find(
      (agent) => agent.threadId === RUN_THREAD,
    );
    expect(running?.state).toBe("running");
    expect(running?.model).toEqual({
      id: "glm-4.6",
      displayName: "GLM-4.6",
      evidence: "queued",
    });
    await harness.dispose();
  });

  it("shows a stopping thread as running with the stop called out", async () => {
    const { harness, store, shared } = seedCriterionFixture();
    store.tasks.upsertTaskThread({
      taskId: shared.id,
      threadId: "thr_stopping",
      presetName: "worker",
      title: "thr_stopping",
      liveStatus: "working",
    });
    harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({
        id: threadId,
        status:
          threadId === "thr_stopping" ? "stopping" : "idle",
      }),
    );
    const snapshot = await readAgents(harness);
    const stopping = snapshot.agents.find(
      (agent) => agent.threadId === "thr_stopping",
    );
    expect(stopping?.state).toBe("running");
    expect(stopping?.detail).toBe("stop requested");
    await harness.dispose();
  });

  it("reports the transition to running on refresh", async () => {
    let status: ThreadOverrides["status"] = "starting";
    const { harness } = seedCriterionFixture({
      threads: {
        [STARTING_THREAD]: { status: "starting" },
      },
    });
    harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
      makeThreadResponse({ id: threadId, status }),
    );
    const before = await readAgents(harness);
    expect(
      before.agents.find((agent) => agent.threadId === STARTING_THREAD)?.state,
    ).toBe("starting");
    status = "active";
    const after = await readAgents(harness);
    expect(
      after.agents.find((agent) => agent.threadId === STARTING_THREAD)?.state,
    ).toBe("running");
    expect(after.revision).not.toBe(before.revision);
    await harness.dispose();
  });
});
