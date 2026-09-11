import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ActiveAgent, ActiveAgentState } from "../../shared/contract.js";
import { useActiveAgents, useProjects } from "../../shell/data.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { Button } from "@bb/shared-ui/button";
import { DelayedLoading } from "@bb/shared-ui/delayed-loading";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { Skeleton } from "@bb/shared-ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@bb/shared-ui/select";
import { cn } from "@bb/shared-ui/lib/utils";

export type AgentsViewMode = "active" | "running" | "blocked";

export const AGENT_STATE_LABELS: Record<ActiveAgentState, string> = {
  running: "Running",
  queued: "Queued",
  starting: "Starting",
  idle: "Idle",
  finished: "Finished",
  stale: "Stale",
  unknown: "Unknown",
};

const STATE_META: Record<ActiveAgentState, { label: string; className: string }> =
  {
    running: {
      label: "Running",
      className: "bg-success/15 text-success",
    },
    queued: {
      label: "Queued",
      className: "bg-warning/15 text-warning",
    },
    starting: {
      label: "Starting",
      className: "bg-primary/15 text-primary",
    },
    idle: {
      label: "Idle",
      className: "bg-secondary text-muted-foreground",
    },
    finished: {
      label: "Finished",
      className: "bg-secondary text-muted-foreground",
    },
    stale: {
      label: "Stale",
      className: "bg-secondary text-muted-foreground",
    },
    unknown: {
      label: "Unknown",
      className: "bg-destructive/15 text-destructive",
    },
  };

const BLOCKER_LABELS: Record<string, string> = {
  interaction: "Waiting for approval",
  plugin: "Held by plugin",
  "host-offline": "Host offline",
  "failed-dispatch": "Dispatch failed",
  "thread-error": "Thread error",
};

function AgentStateChip({ agent }: { agent: ActiveAgent }) {
  const meta = STATE_META[agent.state];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        meta.className,
      )}
      title={agent.detail ?? undefined}
    >
      {agent.state === "running" ? (
        <span
          aria-hidden
          className="size-1.5 animate-pulse rounded-full bg-current"
        />
      ) : null}
      {meta.label}
      {agent.detail ? (
        <span className="font-normal opacity-80">· {agent.detail}</span>
      ) : null}
    </span>
  );
}

function AgentModelChip({ agent }: { agent: ActiveAgent }) {
  const evidenceLabel =
    agent.model.evidence === "queued"
      ? "Queued"
      : agent.model.evidence === "last-turn"
        ? "Last used"
        : null;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
      title={
        agent.model.id === null
          ? "The model could not be read from the thread"
          : `Model: ${agent.model.id}`
      }
    >
      <Icon name="Brain" className="size-3 shrink-0" />
      <span className="max-w-40 truncate">{agent.model.displayName}</span>
      {evidenceLabel !== null ? (
        <span className="shrink-0 opacity-70">({evidenceLabel})</span>
      ) : null}
    </span>
  );
}

function AgentBlockerChip({ agent }: { agent: ActiveAgent }) {
  if (agent.blocker === null) return null;
  const label = BLOCKER_LABELS[agent.blocker.kind] ?? agent.blocker.kind;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive"
      title={agent.blocker.detail ?? undefined}
    >
      <Icon name="AlertCircle" className="size-3 shrink-0" />
      {label}
      {agent.blocker.detail ? (
        <span className="max-w-40 truncate font-normal opacity-80">
          · {agent.blocker.detail}
        </span>
      ) : null}
    </span>
  );
}

function AgentRow({ agent }: { agent: ActiveAgent }) {
  const navigate = useBbNavigate();
  const { go } = useTasksNavigation();
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border-hairline px-3 py-2 max-md:pointer-coarse:py-3 @2xl:flex-row @2xl:items-center @2xl:gap-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            className="shrink-0 font-mono text-xs text-muted-foreground hover:text-foreground"
            onClick={() => go({ kind: "task", taskKey: agent.taskKey })}
          >
            {agent.taskKey}
          </button>
          <span className="min-w-0 flex-1 truncate text-sm">{agent.title}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="truncate">{agent.presetName}</span>
          {agent.providerId !== null ? (
            <span className="truncate">{agent.providerId}</span>
          ) : null}
          <AgentModelChip agent={agent} />
          <AgentBlockerChip agent={agent} />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <AgentStateChip agent={agent} />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1.5 px-2 text-xs"
          onClick={() => navigate.toThread(agent.threadId)}
        >
          <Icon name="ExternalLink" className="size-3" />
          Open thread
        </Button>
      </div>
    </div>
  );
}

function matchesSearch(agent: ActiveAgent, search: string): boolean {
  const haystack = [
    agent.taskKey,
    agent.taskTitle,
    agent.title,
    agent.presetName,
    agent.model.displayName,
    ...(agent.model.id === null ? [] : [agent.model.id]),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(search);
}

function AgentsEmptyState({ mode }: { mode: AgentsViewMode }) {
  const copy = {
    active: "No agents working right now",
    running: "No agents running right now",
    blocked: "No blocked agents",
  }[mode];
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-md bg-secondary text-muted-foreground">
        <Icon name="Zap" className="size-5" />
      </div>
      <p className="text-sm text-muted-foreground">{copy}</p>
    </div>
  );
}

interface GroupedAgents {
  taskId: string;
  taskKey: string;
  taskTitle: string;
  agents: ActiveAgent[];
}

function groupAgentsByTask(agents: readonly ActiveAgent[]): GroupedAgents[] {
  const groups = new Map<string, GroupedAgents>();
  for (const agent of agents) {
    const group = groups.get(agent.taskId);
    if (group === undefined) {
      groups.set(agent.taskId, {
        taskId: agent.taskId,
        taskKey: agent.taskKey,
        taskTitle: agent.taskTitle,
        agents: [agent],
      });
    } else {
      group.agents.push(agent);
    }
  }
  return [...groups.values()];
}

function selectAgentsForMode(
  agents: readonly ActiveAgent[],
  mode: AgentsViewMode,
): ActiveAgent[] {
  switch (mode) {
    case "active":
      return [...agents];
    case "running":
      return agents.filter((agent) => agent.state === "running");
    case "blocked":
      return agents.filter((agent) => agent.blocker !== null);
  }
}

export function AgentsView({ mode }: { mode: AgentsViewMode }) {
  const agentsQuery = useActiveAgents();
  const projectsQuery = useProjects();
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const { go } = useTasksNavigation();

  if (agentsQuery.data === undefined && agentsQuery.error === null) {
    return (
      <DelayedLoading>
        <div className="space-y-2 p-4">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-14 w-full rounded-md" />
          ))}
        </div>
      </DelayedLoading>
    );
  }

  if (agentsQuery.error !== null && agentsQuery.data === undefined) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-destructive">Couldn't load agents</p>
        <p className="text-xs text-muted-foreground">{agentsQuery.error}</p>
        <Button size="sm" variant="outline" onClick={agentsQuery.refresh}>
          <Icon name="RotateCcw" className="size-3.5" />
          Retry
        </Button>
      </div>
    );
  }

  const snapshot = agentsQuery.data;
  if (snapshot === undefined) {
    return <AgentsEmptyState mode={mode} />;
  }

  const totalAgents = snapshot.agents.length;
  const modeAgents = selectAgentsForMode(snapshot.agents, mode);
  const trimmedSearch = search.trim().toLowerCase();
  const filtered = modeAgents.filter(
    (agent) =>
      (projectFilter === "all" || agent.projectId === projectFilter) &&
      (trimmedSearch === "" || matchesSearch(agent, trimmedSearch)),
  );
  const groups = groupAgentsByTask(filtered);
  const filteredTaskTotal = groups.length;

  const summary = {
    active: `${filtered.length} agents across ${filteredTaskTotal} tasks`,
    running: `${filtered.length} agents running across ${filteredTaskTotal} tasks`,
    blocked: `${filtered.length} blocked agents across ${filteredTaskTotal} tasks`,
  }[mode];

  const isNarrowed =
    filtered.length !== totalAgents ||
    filteredTaskTotal !== snapshot.taskTotal;

  return (
    <div className="flex min-h-full flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium" data-testid="agents-summary">
          {summary}
        </span>
        {isNarrowed ? (
          <span className="text-xs text-muted-foreground">
            of {totalAgents} total
          </span>
        ) : null}
        {mode === "blocked" ? (
          <span className="w-full text-xs text-muted-foreground">
            Blockers shown here come from thread evidence only (approval
            holds, plugin holds, offline hosts, failed dispatches, thread
            errors). Tasks have no blocker records upstream, so a blocked task
            with no agent thread cannot appear yet.
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search agents"
            aria-label="Search agents"
            className="h-8 w-44 max-md:pointer-coarse:h-9"
          />
          <Select value={projectFilter} onValueChange={setProjectFilter}>
            <SelectTrigger className="h-8 w-40" aria-label="Filter by project">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All projects</SelectItem>
              {(projectsQuery.data ?? []).map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {groups.length === 0 ? (
        <AgentsEmptyState mode={mode} />
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((group) => (
            <section key={group.taskId} className="flex flex-col gap-1.5">
              <button
                type="button"
                className="flex min-w-0 items-baseline gap-2 rounded-sm text-left"
                onClick={() => go({ kind: "task", taskKey: group.taskKey })}
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {group.taskKey}
                </span>
                <span className="truncate text-sm font-medium">
                  {group.taskTitle}
                </span>
                <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                  {group.agents.length}{" "}
                  {group.agents.length === 1 ? "agent" : "agents"}
                </span>
              </button>
              {group.agents.map((agent) => (
                <AgentRow key={agent.id} agent={agent} />
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
