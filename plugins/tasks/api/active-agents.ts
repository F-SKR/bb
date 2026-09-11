import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type {
  ActiveAgent,
  ActiveAgentBlocker,
  ActiveAgentModel,
  ActiveAgentState,
  ActiveAgentsSnapshot,
} from "../shared/contract.js";

/** One counted record: a Tasks task-thread attachment that is still marked
 *  starting/working, joined with the task and project it belongs to. */
export interface ActiveAgentRecord {
  id: string;
  taskId: string;
  taskKey: string;
  taskTitle: string;
  projectId: string;
  threadId: string;
  presetName: string;
  title: string;
  attachedAt: string;
  updatedAt: string;
}

type SdkThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
type SdkQueuedMessage = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["queuedMessages"]["list"]>
>[number];

/** The fresh per-thread data sources the snapshot is built from. They are
 *  injected so tests can drive the projection without a live BB server. */
export interface ActiveAgentEvidence {
  threadsGet: (threadId: string) => Promise<SdkThread>;
  queuedMessagesList: (threadId: string) => Promise<SdkQueuedMessage[]>;
  lastTurnRequestModel: (threadId: string) => Promise<string | null>;
}

export type ActiveAgentClassification = {
  state: ActiveAgentState;
  detail: string | null;
};

/** Blockers come only from positive thread evidence. Ordinary queue waits
 *  (clock, running turn, turn start, provisioning) are not blockers. A
 *  plugin hold or an offline host is, and an `interaction` wait is an
 *  approval hold. The plugin wait reason itself is free prose on the wire
 *  (queuedMessageWaitReasonSchema), so an "ordinary capacity" hold cannot be
 *  told apart from an actionable one without parsing that prose — the reason
 *  is shown verbatim instead, and the typed-reason contract is a documented
 *  upstream gap. */
const BLOCKED_WAIT_KINDS = new Set(["interaction", "plugin", "host-offline"]);

/** Derive the display state of one counted record from fresh thread data
 *  alone — never from the stored Tasks live status, which may be stale.
 *  Running needs positive execution evidence, queued needs a queued message,
 *  starting needs current startup evidence; an idle thread with no turn and
 *  no queue is Idle, and only a readable record with none of those is stale.
 *  An unreadable record becomes unknown (its classification failure travels
 *  in `detail`). */
export function classifyActiveAgent(
  thread: SdkThread,
): ActiveAgentClassification {
  if (thread.deletedAt !== null) {
    return { state: "stale", detail: "thread was deleted" };
  }
  if (thread.archivedAt !== null) {
    return { state: "stale", detail: "thread was archived" };
  }
  if (thread.status === "active" || thread.status === "stopping") {
    // The durable status still says active, but a host that stays away past
    // its reconnect grace is not executing anything right now.
    if (thread.runtime.displayStatus === "waiting-for-host") {
      return { state: "stale", detail: "waiting for its host" };
    }
    // `stopping` still carries a live run — it only means a stop has been
    // requested and the run has not settled yet — so it stays running, with
    // the stop said out loud.
    return {
      state: "running",
      detail: thread.status === "stopping" ? "stop requested" : null,
    };
  }
  if (thread.status === "starting") {
    return { state: "starting", detail: null };
  }
  if (thread.queuedMessageCount > 0) {
    return { state: "queued", detail: null };
  }
  switch (thread.status) {
    case "pending":
      return { state: "stale", detail: "created but never dispatched" };
    case "idle":
      return { state: "idle", detail: null };
    case "error":
      return { state: "stale", detail: "last turn failed" };
  }
}

function blockedFromQueuedRows(
  rows: readonly SdkQueuedMessage[],
): ActiveAgentBlocker | null {
  for (const row of rows) {
    if (row.failureReason !== null) {
      return { kind: "failed-dispatch", detail: row.failureReason };
    }
  }
  for (const row of rows) {
    if (row.waitingOn === null || !BLOCKED_WAIT_KINDS.has(row.waitingOn.kind)) {
      continue;
    }
    if (row.waitingOn.kind === "plugin") {
      return {
        kind: "plugin",
        detail: `${row.waitingOn.pluginId}: ${row.waitingOn.reason}`,
      };
    }
    if (row.waitingOn.kind === "host-offline") {
      return { kind: "host-offline", detail: row.waitingOn.hostName };
    }
    if (row.waitingOn.kind === "interaction") {
      return { kind: "interaction", detail: null };
    }
  }
  return null;
}

function buildModelEvidence(
  state: ActiveAgentState,
  queuedRows: readonly SdkQueuedMessage[],
  lastTurnModel: string | null,
  resolveModelDisplayName: (modelId: string) => string,
): ActiveAgentModel {
  const queuedRow = queuedRows[0];
  const queuedModel = () =>
    queuedRow === undefined
      ? null
      : {
          id: queuedRow.model,
          displayName: resolveModelDisplayName(queuedRow.model),
          evidence: "queued" as const,
        };
  if (state === "running" || state === "starting") {
    // The stored turn request precedes execution, so it is the current
    // turn's identity — it outranks any follow-up row already queued on the
    // thread, which may name a different model.
    if (lastTurnModel !== null) {
      return {
        id: lastTurnModel,
        displayName: resolveModelDisplayName(lastTurnModel),
        evidence: "current-turn",
      };
    }
    // No readable turn request: the queued row is the only model evidence
    // the thread offers, and it is labeled as queued rather than passed off
    // as the running model.
    return queuedModel() ?? { id: null, displayName: "Model unknown", evidence: "none" };
  }
  if (queuedRow !== undefined) {
    return queuedModel()!;
  }
  if (lastTurnModel !== null) {
    return {
      id: lastTurnModel,
      displayName: resolveModelDisplayName(lastTurnModel),
      evidence: "last-turn",
    };
  }
  return { id: null, displayName: "Model unknown", evidence: "none" };
}

export async function buildActiveAgentsSnapshot(
  evidence: ActiveAgentEvidence,
  records: readonly ActiveAgentRecord[],
  resolveModelDisplayName: (modelId: string) => string,
): Promise<ActiveAgentsSnapshot> {
  const agents = await Promise.all(
    records.map(async (record): Promise<ActiveAgent> => {
      let state: ActiveAgentState;
      let detail: string | null = null;
      let providerId: string | null = null;
      let model: ActiveAgentModel = {
        id: null,
        displayName: "Model unknown",
        evidence: "none",
      };
      let blocker: ActiveAgentBlocker | null = null;
      try {
        const thread = await evidence.threadsGet(record.threadId);
        providerId = thread.providerId;
        ({ state, detail } = classifyActiveAgent(thread));
        const queuedRows =
          thread.queuedMessageCount > 0
            ? await evidence.queuedMessagesList(record.threadId)
            : [];
        let lastTurnModel: string | null = null;
        try {
          lastTurnModel = await evidence.lastTurnRequestModel(record.threadId);
        } catch {
          // A thread whose events are unreadable still classifies; it just
          // falls back to "Model unknown" for the model chip.
        }
        model = buildModelEvidence(
          state,
          queuedRows,
          lastTurnModel,
          resolveModelDisplayName,
        );
        if (state === "queued") {
          blocker = blockedFromQueuedRows(queuedRows);
        } else if (state === "stale" && thread.status === "error") {
          blocker = { kind: "thread-error", detail: null };
        }
      } catch (error) {
        state = "unknown";
        detail = error instanceof Error ? error.message : String(error);
      }
      return { ...record, providerId, state, detail, model, blocker };
    }),
  );
  const taskTotal = new Set(agents.map((agent) => agent.taskId)).size;
  const revision = createHash("sha256")
    .update(
      JSON.stringify(
        [...agents]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((agent) => [
            agent.id,
            agent.state,
            agent.detail,
            agent.model,
            agent.blocker,
          ]),
      ),
    )
    .digest("base64url");
  return { agents, taskTotal, revision };
}
