// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeTask } from "../test-fixtures.js";
import type { Task } from "../shared/contract.js";

if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

const app = await loadPluginApp(() => import("../app"));
const { parseTasksRoute, tasksRouteToSubPath } = await import("./routes.js");
const { pagerPosition } = await import("./topbar.js");
const { loadViewMode } = await import("./view-preference.js");
const { querySnapshotStorageKey, resetQuerySnapshotStateForTest } =
  await import("./query-snapshot.js");

const tasksRegistration = app.navPanels[0]!;
const navigationView = tasksRegistration.fixedTabs?.[0]!;
const navigationRegistration = {
  ...tasksRegistration,
  component: navigationView.component,
};

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const OTHER_PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP2";
const FOLDER_ID = "01HZZZZZZZZZZZZZZZZZZZZZF1";

const project = {
  id: PROJECT_ID,
  name: "Tasks Plugin",
  prefix: "TSK",
  nextTaskNumber: 5,
  color: "blue",
  folderId: FOLDER_ID,
  linkedBbProjectId: null,
  createdAt: "2026-07-15T00:00:00.000Z",
};

const folder = {
  id: FOLDER_ID,
  name: "bb",
  parentFolderId: null,
  createdAt: "2026-07-15T00:00:00.000Z",
};

function seededRpc(overrides: Record<string, unknown> = {}) {
  return {
    listProjects: () => ({ projects: [project] }),
    listFolders: () => ({ folders: [folder] }),
    listPresets: () => ({ presets: [] }),
    sidebarSummary: () => ({
      projects: [{ projectId: PROJECT_ID, taskCount: 3, activeAgentCount: 1 }],
    }),
    listTasks: () => ({ tasks: [] }),
    getTaskByKey: () => ({ task: null }),
    activeAgents: () => ({ agents: [], taskTotal: 0, revision: "" }),
    ...overrides,
  };
}

const emptyRpc = seededRpc({
  listProjects: () => ({ projects: [] }),
  listFolders: () => ({ folders: [] }),
  sidebarSummary: () => ({ projects: [] }),
});

describe("tasks route grammar", () => {
  it("round-trips every route kind and decodes host-encoded subPaths", () => {
    const routes = [
      { kind: "all" },
      { kind: "active" },
      { kind: "running" },
      { kind: "blocked" },
      { kind: "manage" },
      { kind: "task", taskKey: "TSK-4" },
      { kind: "project", projectId: PROJECT_ID, view: "list" },
      { kind: "project", projectId: PROJECT_ID, view: "board" },
      { kind: "project", projectId: PROJECT_ID, view: null },
    ] as const;
    for (const route of routes) {
      expect(parseTasksRoute(tasksRouteToSubPath(route))).toEqual(route);
    }
    expect(parseTasksRoute(`${PROJECT_ID}%3Fview%3Dboard`)).toEqual({
      kind: "project",
      projectId: PROJECT_ID,
      view: "board",
    });
    expect(parseTasksRoute("")).toEqual({ kind: "all" });
    expect(parseTasksRoute(`${PROJECT_ID}?view=kanban`)).toEqual({
      kind: "project",
      projectId: PROJECT_ID,
      view: null,
    });
  });
});

describe("project view preference", () => {
  const openProject = (subPath: string) =>
    renderSlot(
      app.navPanels[0]!,
      { subPath },
      { rpc: seededRpc({ listLabels: () => ({ labels: [] }) }) },
    );

  it("restores the remembered view when the URL names none", async () => {
    const listed = openProject(`${PROJECT_ID}?view=list`);
    fireEvent.click(await listed.findByRole("button", { name: "Board" }));
    expect(listed.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "tasks",
      options: { subPath: `${PROJECT_ID}?view=board` },
    });
    listed.lifecycle.unmount();

    const reopened = openProject(PROJECT_ID);
    const boardSegment = await reopened.findByRole("button", { name: "Board" });
    expect(boardSegment.getAttribute("aria-pressed")).toBe("true");
    await reopened.findByText("In Review");
  });

  it("keeps per-project choices apart and defaults unseen projects to the last one used", async () => {
    const slot = openProject(`${PROJECT_ID}?view=list`);
    fireEvent.click(await slot.findByRole("button", { name: "Board" }));
    slot.lifecycle.unmount();

    expect(loadViewMode(PROJECT_ID)).toBe("board");
    expect(loadViewMode(OTHER_PROJECT_ID)).toBe("board");

    const other = renderSlot(
      app.navPanels[0]!,
      { subPath: `${OTHER_PROJECT_ID}?view=list` },
      { rpc: seededRpc() },
    );
    fireEvent.click(await other.findByRole("button", { name: "List" }));
    expect(loadViewMode(OTHER_PROJECT_ID)).toBe("list");
    expect(loadViewMode(PROJECT_ID)).toBe("board");
  });

  it("navigates from the sidebar without pinning a view", async () => {
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "all" },
      { rpc: seededRpc({ listLabels: () => ({ labels: [] }) }) },
    );
    fireEvent.click(await slot.findByText("Tasks Plugin"));
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "tasks",
      options: { subPath: PROJECT_ID },
    });
  });

  it("still toggles when client storage rejects writes", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is disabled", "SecurityError");
    });
    const slot = openProject(`${PROJECT_ID}?view=list`);
    fireEvent.click(await slot.findByRole("button", { name: "Board" }));
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "tasks",
      options: { subPath: `${PROJECT_ID}?view=board` },
    });
  });
});

function pagerTask(key: string, status: Task["status"], position: number) {
  return makeTask({
    id: `01HZZZZZZZZZZZZZZZZZZZZ${key.replace("-", "")}`,
    projectId: PROJECT_ID,
    number: position,
    key,
    title: key,
    status,
    position,
  });
}

describe("task pager", () => {
  const tasks = [
    pagerTask("TSK-3", "done", 1),
    pagerTask("TSK-1", "in_progress", 1),
    pagerTask("TSK-2", "todo", 1),
    pagerTask("TSK-4", "todo", 2),
  ];

  it("orders siblings like the list view and exposes neighbors", () => {
    expect(pagerPosition(tasks, "TSK-4")).toEqual({
      index: 2,
      total: 4,
      prevKey: "TSK-2",
      nextKey: "TSK-1",
    });
    expect(pagerPosition(tasks, "tsk-2")).toMatchObject({
      index: 1,
      prevKey: null,
    });
    expect(pagerPosition(tasks, "TSK-3")).toMatchObject({
      index: 4,
      nextKey: null,
    });
  });

  it("has no position for unknown keys", () => {
    expect(pagerPosition(tasks, "TSK-99")).toBeNull();
    expect(pagerPosition([], "TSK-1")).toBeNull();
  });

  it("renders n / m on the task route and steps to the next sibling", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-4" },
      {
        rpc: seededRpc({
          listTasks: () => ({ tasks }),
          listLabels: () => ({ labels: [] }),
          listAttachments: () => ({ attachments: [] }),
          listTaskThreads: () => ({ taskThreads: [] }),
          listComments: () => ({ comments: [] }),
        }),
      },
    );
    await slot.findByText("2 / 4");
    fireEvent.click(slot.getByRole("button", { name: "Next task" }));
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "tasks",
      options: { subPath: "task/TSK-1" },
    });
  });
});

describe("tasks app shell", () => {
  it("registers navigation as a BB-owned fixed panel tab", () => {
    expect(tasksRegistration.fixedTabs).toMatchObject([
      {
        id: "navigation",
        title: "Navigation",
        icon: "ListView",
        layout: "flush",
      },
    ]);
  });

  it("does not treat the first connection as a reconnect", async () => {
    let requests = 0;
    let title = "Initial connection title";
    const task = {
      ...pagerTask("TSK-4", "todo", 1),
      description: "",
      labelIds: [],
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "all" },
      {
        realtimeConnectionState: "connecting",
        rpc: seededRpc({
          listTasks: () => {
            requests += 1;
            return { tasks: [{ ...task, title }] };
          },
          listLabels: () => ({ labels: [] }),
          listAttachments: () => ({ attachments: [] }),
          listTaskThreads: () => ({ taskThreads: [] }),
          listComments: () => ({ comments: [] }),
        }),
      },
    );
    await slot.findByText("Initial connection title");
    const initialRequests = requests;
    expect(initialRequests).toBeGreaterThan(0);

    await slot.behavior.setRealtimeConnectionState("connected");
    expect(requests).toBe(initialRequests);

    title = "Recovered from connecting state";
    await slot.behavior.setRealtimeConnectionState("connecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    await slot.findByText("Recovered from connecting state");
    expect(requests).toBeGreaterThan(initialRequests);
  });

  it("recovers when the shell mounts during an existing outage", async () => {
    let serverAvailable = false;
    const task = {
      ...pagerTask("TSK-4", "todo", 1),
      title: "Loaded after existing outage",
      description: "",
      labelIds: [],
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "all" },
      {
        realtimeConnectionState: "reconnecting",
        rpc: seededRpc({
          listTasks: async () => {
            if (!serverAvailable) throw new Error("server unavailable");
            return { tasks: [task] };
          },
          listLabels: () => ({ labels: [] }),
          listAttachments: () => ({ attachments: [] }),
          listTaskThreads: () => ({ taskThreads: [] }),
          listComments: () => ({ comments: [] }),
        }),
      },
    );
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some((call) => call.method === "listTasks"),
      ).toBe(true),
    );
    expect(slot.queryByText("Loaded after existing outage")).toBeNull();

    serverAvailable = true;
    await slot.behavior.setRealtimeConnectionState("connected");
    await slot.findByText("Loaded after existing outage");
  });

  it("resyncs the task list after reconnect and supports manual refresh", async () => {
    let title = "Stale list title";
    const task = {
      ...pagerTask("TSK-4", "todo", 1),
      title,
      description: "",
      labelIds: [],
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "all" },
      {
        rpc: seededRpc({
          listTasks: () => ({ tasks: [{ ...task, title }] }),
          listLabels: () => ({ labels: [] }),
          listAttachments: () => ({ attachments: [] }),
          listTaskThreads: () => ({ taskThreads: [] }),
          listComments: () => ({ comments: [] }),
        }),
      },
    );
    await slot.findByText("Stale list title");

    title = "Recovered list title";
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    expect(slot.queryByText("Recovered list title")).toBeNull();
    await slot.behavior.setRealtimeConnectionState("connected");
    await slot.findByText("Recovered list title");

    title = "Manually refreshed list title";
    fireEvent.click(slot.getByRole("button", { name: "Refresh tasks" }));
    await slot.findByText("Manually refreshed list title");
  });

  it("shares manual refresh across the page and right-panel queries", async () => {
    let listTaskCalls = 0;
    let listProjectCalls = 0;
    let holdProjects = false;
    let releaseProjects: (() => void) | null = null;
    const page = renderSlot(
      app.navPanels[0]!,
      { subPath: "all" },
      {
        rpc: seededRpc({
          listTasks: () => {
            listTaskCalls += 1;
            return { tasks: [] };
          },
        }),
      },
    );
    const panel = renderSlot(
      navigationRegistration,
      { subPath: "all" },
      {
        rpc: seededRpc({
          listProjects: async () => {
            listProjectCalls += 1;
            if (holdProjects) {
              await new Promise<void>((resolve) => {
                releaseProjects = resolve;
              });
            }
            return { projects: [project] };
          },
        }),
      },
    );
    await page.findByRole("button", { name: "Refresh tasks" });
    await panel.findByText("Tasks Plugin");
    const initialTaskCalls = listTaskCalls;
    const initialProjectCalls = listProjectCalls;

    holdProjects = true;
    const refresh = page.getByRole("button", {
      name: "Refresh tasks",
    }) as HTMLButtonElement;
    fireEvent.click(refresh);

    await waitFor(() =>
      expect(listTaskCalls).toBeGreaterThan(initialTaskCalls),
    );
    await waitFor(() =>
      expect(listProjectCalls).toBeGreaterThan(initialProjectCalls),
    );
    expect(refresh.disabled).toBe(true);
    const taskCallsWhilePanelPending = listTaskCalls;
    fireEvent.click(refresh);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listTaskCalls).toBe(taskCallsWhilePanelPending);

    releaseProjects?.();
    await waitFor(() => expect(refresh.disabled).toBe(false));
  });

  it("exposes a subtle icon-only refresh control left of New task", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "all" },
      {
        rpc: seededRpc({
          listTasks: () => ({
            tasks: [
              {
                ...pagerTask("TSK-4", "todo", 1),
                title: "Order probe",
                description: "",
                labelIds: [],
              },
            ],
          }),
          listLabels: () => ({ labels: [] }),
          listAttachments: () => ({ attachments: [] }),
          listTaskThreads: () => ({ taskThreads: [] }),
          listComments: () => ({ comments: [] }),
        }),
      },
    );
    await slot.findByText("Order probe");

    const refresh = slot.getByRole("button", { name: "Refresh tasks" });
    const newTask = slot.getByRole("button", { name: /New task/i });

    expect(refresh.textContent?.trim() ?? "").not.toMatch(/Refresh/i);
    expect(refresh.getAttribute("aria-label")).toBe("Refresh tasks");
    expect(refresh.className).toMatch(/size-7/);

    expect(
      refresh.compareDocumentPosition(newTask) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    const tabbables = [refresh, newTask];
    for (let i = 0; i < tabbables.length - 1; i++) {
      expect(
        tabbables[i]!.compareDocumentPosition(tabbables[i + 1]!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }

    refresh.focus();
    expect(document.activeElement).toBe(refresh);
  });

  it("single-flights manual refresh against deferred RPCs and keeps geometry stable", async () => {
    let listTasksCalls = 0;
    let title = "Flight title A";
    let holdListTasks = false;
    const pendingResolvers: Array<() => void> = [];
    const releaseAllPending = () => {
      const resolvers = pendingResolvers.splice(0, pendingResolvers.length);
      for (const resolve of resolvers) resolve();
    };
    const task = {
      ...pagerTask("TSK-4", "todo", 1),
      title,
      description: "",
      labelIds: [],
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "all" },
      {
        rpc: seededRpc({
          listTasks: () => {
            listTasksCalls += 1;
            if (!holdListTasks) {
              return { tasks: [{ ...task, title }] };
            }
            return new Promise((resolve) => {
              pendingResolvers.push(() =>
                resolve({ tasks: [{ ...task, title }] }),
              );
            });
          },
          listLabels: () => ({ labels: [] }),
          listAttachments: () => ({ attachments: [] }),
          listTaskThreads: () => ({ taskThreads: [] }),
          listComments: () => ({ comments: [] }),
        }),
      },
    );
    await slot.findByText("Flight title A");
    const baselineCalls = listTasksCalls;
    expect(baselineCalls).toBeGreaterThan(0);

    const refresh = slot.getByRole("button", {
      name: "Refresh tasks",
    }) as HTMLButtonElement;
    const idleClassName = refresh.className;
    expect(idleClassName).toMatch(/size-7/);
    expect(refresh.getAttribute("aria-busy")).not.toBe("true");
    expect(refresh.disabled).toBe(false);
    expect(idleClassName).toMatch(/active:bg-state-active/);

    fireEvent.pointerMove(refresh);
    fireEvent.focus(refresh);
    expect(refresh.getAttribute("aria-label")).toBe("Refresh tasks");

    holdListTasks = true;
    title = "Flight title B";
    fireEvent.click(refresh);
    await waitFor(() => expect(listTasksCalls).toBeGreaterThan(baselineCalls));
    expect(refresh.disabled).toBe(true);
    expect(refresh.getAttribute("aria-busy")).toBe("true");
    expect(refresh.className).toBe(idleClassName);

    const callsWhilePending = listTasksCalls;
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    refresh.focus();
    fireEvent.click(refresh);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listTasksCalls).toBe(callsWhilePending);

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(refresh.disabled).toBe(true);
    expect(listTasksCalls).toBe(callsWhilePending);

    releaseAllPending();
    await slot.findByText("Flight title B");
    await waitFor(() => {
      expect(
        (
          slot.getByRole("button", {
            name: "Refresh tasks",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    });

    title = "Flight title C";
    fireEvent.click(slot.getByRole("button", { name: "Refresh tasks" }));
    await waitFor(() =>
      expect(listTasksCalls).toBeGreaterThan(callsWhilePending),
    );
    releaseAllPending();
    await slot.findByText("Flight title C");
    await waitFor(() => {
      const button = slot.getByRole("button", {
        name: "Refresh tasks",
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      expect(button.getAttribute("aria-busy")).not.toBe("true");
    });
    expect(
      (slot.getByRole("button", { name: "Refresh tasks" }) as HTMLButtonElement)
        .className,
    ).toMatch(/size-7/);
  });

  it("retains stale list data when a manual refresh fails, then recovers", async () => {
    let shouldFail = false;
    let title = "Stable title";
    const task = {
      ...pagerTask("TSK-4", "todo", 1),
      title,
      description: "",
      labelIds: [],
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "all" },
      {
        rpc: seededRpc({
          listTasks: () => {
            if (shouldFail) throw new Error("refresh failed");
            return { tasks: [{ ...task, title }] };
          },
          listLabels: () => ({ labels: [] }),
          listAttachments: () => ({ attachments: [] }),
          listTaskThreads: () => ({ taskThreads: [] }),
          listComments: () => ({ comments: [] }),
        }),
      },
    );
    await slot.findByText("Stable title");

    shouldFail = true;
    fireEvent.click(slot.getByRole("button", { name: "Refresh tasks" }));
    await waitFor(() => expect(slot.getByText("Stable title")).toBeDefined());
    await waitFor(() => {
      expect(
        (
          slot.getByRole("button", {
            name: "Refresh tasks",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    });
    expect(slot.getByText("Stable title")).toBeDefined();

    shouldFail = false;
    title = "Recovered after failure";
    fireEvent.click(slot.getByRole("button", { name: "Refresh tasks" }));
    await slot.findByText("Recovered after failure");
  });

  it("resyncs an open task detail after reconnect", async () => {
    let title = "Stale detail title";
    const task = {
      ...pagerTask("TSK-4", "todo", 1),
      title,
      description: "",
      labelIds: [],
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-4" },
      {
        rpc: seededRpc({
          getTaskByKey: () => ({ task: { ...task, title } }),
          listTasks: () => ({ tasks: [{ ...task, title }] }),
          listLabels: () => ({ labels: [] }),
          listAttachments: () => ({ attachments: [] }),
          listTaskThreads: () => ({ taskThreads: [] }),
          listComments: () => ({ comments: [] }),
        }),
      },
    );
    await slot.findByRole("textbox", { name: "Task title" });
    expect(slot.getByRole("textbox", { name: "Task title" }).textContent).toBe(
      "Stale detail title",
    );

    title = "Recovered detail title";
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    expect(slot.getByRole("textbox", { name: "Task title" }).textContent).toBe(
      "Stale detail title",
    );
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() =>
      expect(
        slot.getByRole("textbox", { name: "Task title" }).textContent,
      ).toBe("Recovered detail title"),
    );
  });

  describe("last-known snapshot", () => {
    const projectsKey = querySnapshotStorageKey("projects");
    const foldersKey = querySnapshotStorageKey("folders");
    const summaryKey = querySnapshotStorageKey("sidebar-summary");
    const summary = {
      projectId: PROJECT_ID,
      taskCount: 3,
      activeAgentCount: 1,
    };
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    it("never paints the empty state while projects are unknown", async () => {
      const projects = deferred<{ projects: never[] }>();
      const slot = renderSlot(
        app.navPanels[0]!,
        { subPath: "" },
        {
          rpc: seededRpc({
            listProjects: () => projects.promise,
            sidebarSummary: () => ({ projects: [] }),
          }),
        },
      );
      expect(slot.queryByText("No projects yet")).toBeNull();
      projects.resolve({ projects: [] });
      await slot.findByText("No projects yet");
    });

    it("paints the last-known empty state before listProjects resolves", () => {
      window.localStorage.setItem(projectsKey, JSON.stringify([]));
      window.localStorage.setItem(foldersKey, JSON.stringify([]));
      window.localStorage.setItem(summaryKey, JSON.stringify([]));
      const projects = deferred<{ projects: never[] }>();
      const slot = renderSlot(
        app.navPanels[0]!,
        { subPath: "" },
        {
          rpc: seededRpc({
            listProjects: () => projects.promise,
            sidebarSummary: () => ({ projects: [] }),
          }),
        },
      );
      expect(slot.getByText("No projects yet")).toBeTruthy();
    });

    it("paints last-known projects before listProjects resolves and never flashes empty", async () => {
      window.localStorage.setItem(projectsKey, JSON.stringify([project]));
      window.localStorage.setItem(foldersKey, JSON.stringify([folder]));
      window.localStorage.setItem(summaryKey, JSON.stringify([summary]));
      const projects = deferred<{ projects: (typeof project)[] }>();
      const rpc = seededRpc({ listProjects: () => projects.promise });
      const panel = renderSlot(
        navigationRegistration,
        { subPath: "" },
        { rpc },
      );
      const page = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc });
      expect(panel.getByText(project.name)).toBeTruthy();
      expect(page.queryByText("No projects yet")).toBeNull();
      projects.resolve({ projects: [project] });
      await waitFor(() => expect(panel.getByText(project.name)).toBeTruthy());
      expect(page.queryByText("No projects yet")).toBeNull();
    });

    it("ignores a malformed snapshot and loads normally", async () => {
      window.localStorage.setItem(projectsKey, "{not json");
      window.localStorage.setItem(
        summaryKey,
        JSON.stringify([{ projectId: 1 }]),
      );
      const slot = renderSlot(
        app.navPanels[0]!,
        { subPath: "" },
        { rpc: emptyRpc },
      );
      expect(slot.queryByText("No projects yet")).toBeNull();
      await slot.findByText("No projects yet");
    });

    it("prunes snapshots written under an older storage version", async () => {
      resetQuerySnapshotStateForTest();
      window.localStorage.setItem(
        "bb-tasks:query-snapshot:v0:projects",
        JSON.stringify([]),
      );
      const slot = renderSlot(
        navigationRegistration,
        { subPath: "" },
        { rpc: seededRpc() },
      );
      await slot.findByText(project.name);
      expect(
        window.localStorage.getItem("bb-tasks:query-snapshot:v0:projects"),
      ).toBeNull();
      expect(window.localStorage.getItem(projectsKey)).not.toBeNull();
    });

    it("records the fetched projects and counts for the next mount", async () => {
      const slot = renderSlot(
        navigationRegistration,
        { subPath: "" },
        { rpc: seededRpc() },
      );
      await slot.findByText(project.name);
      await waitFor(() => {
        expect(
          JSON.parse(window.localStorage.getItem(projectsKey) ?? "null"),
        ).toEqual([project]);
        expect(
          JSON.parse(window.localStorage.getItem(foldersKey) ?? "null"),
        ).toEqual([folder]);
        expect(
          JSON.parse(window.localStorage.getItem(summaryKey) ?? "null"),
        ).toEqual([summary]);
      });
    });

    it("keeps the newer projects snapshot when an older request resolves later", async () => {
      const olderProject = { ...project, name: "Older truth" };
      const newerProject = { ...project, name: "Newer truth" };
      const older = deferred<{ projects: (typeof project)[] }>();
      let calls = 0;
      const rpc = seededRpc({
        listProjects: () => {
          calls += 1;
          return calls === 1 ? older.promise : { projects: [newerProject] };
        },
      });
      renderSlot(navigationRegistration, { subPath: "" }, { rpc });
      const second = renderSlot(
        navigationRegistration,
        { subPath: "" },
        { rpc },
      );
      await second.findByText("Newer truth");
      await waitFor(() =>
        expect(
          JSON.parse(window.localStorage.getItem(projectsKey) ?? "null"),
        ).toEqual([newerProject]),
      );
      older.resolve({ projects: [olderProject] });
      await act(async () => {
        await older.promise;
      });
      expect(
        JSON.parse(window.localStorage.getItem(projectsKey) ?? "null"),
      ).toEqual([newerProject]);
    });

    it.each(["listFolders", "sidebarSummary"])(
      "keeps loaded projects navigable when %s fails",
      async (method) => {
        const slot = renderSlot(
          navigationRegistration,
          { subPath: "all" },
          {
            rpc: seededRpc({
              [method]: () => Promise.reject(new Error("boom")),
            }),
          },
        );
        fireEvent.click(await slot.findByText(project.name));
        expect(slot.navigateCalls).toContainEqual({
          method: "toPluginPanel",
          path: "tasks",
          options: { subPath: PROJECT_ID },
        });
      },
    );
  });

  it("shows the error, not the previous route's rows, when a route change fails", async () => {
    const tasks = [
      {
        ...pagerTask("TSK-4", "todo", 1),
        title: "Scope truth",
        description: "",
        labelIds: [],
      },
    ];
    const rpc = seededRpc({
      listLabels: () => ({ labels: [] }),
      listTasks: () => ({ tasks }),
      activeAgents: () => Promise.reject(new Error("active fetch failed")),
    });
    const Panel = app.navPanels[0]!.component;
    const slot = renderSlot(app.navPanels[0]!, { subPath: "all" }, { rpc });
    await slot.findByText("Scope truth");

    slot.lifecycle.rerender(<Panel subPath="active" />);
    await slot.findByText("Couldn't load agents");
    expect(slot.queryByText("Scope truth")).toBeNull();
    expect(slot.queryByText("No agents working right now")).toBeNull();
  });

  it("shows the empty state and opens the New project dialog", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: emptyRpc,
      },
    );
    await slot.findByText("No projects yet");
    fireEvent.click(slot.getByRole("button", { name: /New project/ }));
    await slot.findByText("Projects group tasks under a shared key prefix.");
  });

  it("does not paint another scope's empty state while its own rows load", async () => {
    const tasks = [
      {
        ...pagerTask("TSK-4", "todo", 1),
        title: "Scope truth",
        description: "",
        labelIds: [],
      },
    ];
    let deferAll = false;
    let releaseAll: (() => void) | null = null;
    const rpc = seededRpc({
      listLabels: () => ({ labels: [] }),
      listTasks: (input: { activeOnly?: boolean }) => {
        if (!deferAll || input.activeOnly === true) return { tasks };
        return new Promise((resolve) => {
          releaseAll = () => resolve({ tasks });
        });
      },
    });
    const Panel = app.navPanels[0]!.component;
    const slot = renderSlot(app.navPanels[0]!, { subPath: "all" }, { rpc });
    await slot.findByText("Scope truth");

    slot.lifecycle.rerender(<Panel subPath="active" />);
    await slot.findByText("No agents working right now");

    deferAll = true;
    slot.lifecycle.rerender(<Panel subPath="all" />);
    await waitFor(() => expect(releaseAll).not.toBeNull());
    expect(slot.queryByText("No tasks yet")).toBeNull();
    expect(slot.queryByText("Scope truth")).toBeNull();
    act(() => releaseAll!());
    await slot.findByText("Scope truth");
  });

  it("renders board and task subPaths without plugin-owned sidebar chrome", async () => {
    const boardSlot = renderSlot(
      app.navPanels[0]!,
      { subPath: `${PROJECT_ID}?view=board` },
      { rpc: seededRpc() },
    );
    await boardSlot.findByText("Backlog");
    await boardSlot.findByText("In Review");
    expect(boardSlot.getByText("Tasks Plugin")).toBeDefined();
    expect(boardSlot.queryByRole("button", { name: /sidebar/i })).toBeNull();
    cleanup();

    const taskSlot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-4" },
      { rpc: seededRpc() },
    );
    await taskSlot.findByText(/Task TSK-4 was not found/);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(taskSlot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "tasks",
      options: { subPath: "all" },
    });
  });

  it("renders right-panel navigation and routes through the plugin panel", async () => {
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "all" },
      {
        rpc: seededRpc(),
      },
    );
    await slot.findByText("Tasks Plugin");
    expect(slot.getByRole("button", { name: /^All tasks/ })).toBeDefined();
    expect(slot.getByRole("button", { name: "Manage" })).toBeDefined();

    fireEvent.click(slot.getByTitle("Tasks Plugin"));
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "tasks",
      options: { subPath: PROJECT_ID },
    });
  });

  it("does not mount New project queries until the dialog opens", async () => {
    let bbProjectCalls = 0;
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "all" },
      {
        rpc: seededRpc({
          listBbProjects: () => {
            bbProjectCalls += 1;
            return { bbProjects: [] };
          },
        }),
      },
    );
    await slot.findByRole("button", { name: "New project" });
    expect(bbProjectCalls).toBe(0);

    fireEvent.click(slot.getByRole("button", { name: "New project" }));

    await slot.findByText("Projects group tasks under a shared key prefix.");
    expect(bbProjectCalls).toBeGreaterThan(0);
  });

  it("routes 'manage' to the manage panel from right-panel navigation", async () => {
    const panel = renderSlot(
      navigationRegistration,
      { subPath: "all" },
      {
        rpc: seededRpc(),
      },
    );
    await panel.findByRole("button", { name: "Manage" });
    fireEvent.click(panel.getByRole("button", { name: "Manage" }));
    expect(panel.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "tasks",
      options: { subPath: "manage" },
    });
    cleanup();

    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "manage" },
      {
        rpc: seededRpc({ listLabels: () => ({ labels: [] }) }),
      },
    );
    await slot.findByText("Labels, agent presets, and folders.");
  });

  it("opens quick-create on bare 'c' but not from editable targets or dialogs", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "all" },
      {
        rpc: seededRpc(),
      },
    );
    await slot.findByText("All tasks");
    fireEvent.keyDown(window, { key: "c" });
    await slot.findByRole("dialog");
    fireEvent.keyDown(window, { key: "c" });
    expect(slot.getAllByRole("dialog")).toHaveLength(1);
  });

  it("marks only new-worktree presets with the worktree hint", async () => {
    const basePreset = {
      id: "01HZZZZZZZZZZZZZZZZZZZZZE1",
      name: "Default env",
      providerId: "claude-code",
      modelId: "claude-sonnet-5",
      reasoningLevel: "medium",
      serviceTier: null,
      permissionMode: "accept-edits",
      environmentKind: "project-default",
      baseBranch: null,
      machineId: null,
      instructions: "",
      builtin: false,
      createdAt: "2026-07-15T00:00:00.000Z",
    };
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "all" },
      {
        rpc: seededRpc({
          listPresets: () => ({
            presets: [
              basePreset,
              {
                ...basePreset,
                id: "01HZZZZZZZZZZZZZZZZZZZZZE2",
                name: "Worktree env",
                environmentKind: "new-worktree",
                baseBranch: "main",
              },
            ],
          }),
        }),
      },
    );
    await slot.findByText("Worktree env");
    expect(slot.getByText("Default env")).toBeDefined();
    expect(slot.getAllByLabelText("Spawns a new worktree")).toHaveLength(1);
  });

  it("refetches sidebar data when invalidation channels fire", async () => {
    let projectCalls = 0;
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "all" },
      {
        rpc: seededRpc({
          listProjects: () => {
            projectCalls += 1;
            return { projects: [project] };
          },
        }),
      },
    );
    await slot.findByText("Tasks Plugin");
    const before = projectCalls;
    await slot.emitRealtime("projects:changed", { projectId: null });
    await waitFor(() => expect(projectCalls).toBeGreaterThan(before));
    const settled = projectCalls;
    await slot.emitRealtime("comments:changed", { taskId: "x" });
    expect(projectCalls).toBe(settled);
  });
});

describe("agents views", () => {
  const TASK_A = "01HZZZZZZZZZZZZZZZZZZZZZTA";
  const TASK_B = "01HZZZZZZZZZZZZZZZZZZZZZTB";
  const TASK_C = "01HZZZZZZZZZZZZZZZZZZZZZTC";
  const OTHER_PROJECT = "01HZZZZZZZZZZZZZZZZZZZZZP2";

  const agent = (overrides: Record<string, unknown> & {
    id: string;
    threadId: string;
    taskId: string;
    taskKey: string;
  }) => ({
    taskTitle: `Task ${overrides.taskKey}`,
    projectId: PROJECT_ID,
    providerId: "claude-code",
    presetName: "worker",
    detail: null,
    attachedAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    model: { id: "claude-sonnet-5", displayName: "Claude Sonnet 5", evidence: "current-turn" },
    blocker: null,
    ...overrides,
  });

  const criterionAgents = [
    agent({ id: "agent-1", taskId: TASK_A, taskKey: "TSK-1", threadId: "thr_run01", title: "Implementing", state: "running" }),
    agent({
      id: "agent-2", taskId: TASK_A, taskKey: "TSK-1", threadId: "thr_qued1", title: "Queued worker", state: "queued",
      model: { id: "glm-4.6", displayName: "GLM-4.6", evidence: "queued" },
    }),
    agent({ id: "agent-3", taskId: TASK_A, taskKey: "TSK-1", threadId: "thr_idle1", title: "Idle worker", state: "idle", model: { id: "claude-sonnet-5", displayName: "Claude Sonnet 5", evidence: "last-turn" } }),
    agent({
      id: "agent-4", taskId: TASK_B, taskKey: "TSK-2", threadId: "thr_stale1", title: "Lost worker", state: "stale",
      detail: "created but never dispatched", model: { id: null, displayName: "Model unknown", evidence: "none" },
    }),
    agent({
      id: "agent-5", taskId: TASK_C, taskKey: "TSK-3", threadId: "thr_blkd1", title: "Held worker", state: "queued",
      model: { id: null, displayName: "Model unknown", evidence: "none" },
      blocker: { kind: "interaction", detail: null },
      projectId: OTHER_PROJECT,
    }),
  ];

  const agentsRpc = seededRpc({
    activeAgents: () => ({
      agents: criterionAgents,
      taskTotal: 3,
      revision: "fixture-revision",
    }),
  });

  const openAgentsPage = (subPath: string, rpc = agentsRpc) =>
    renderSlot(app.navPanels[0]!, { subPath }, { rpc });

  it("shows every counted agent row, the truthful label, and per-agent states", async () => {
    const slot = openAgentsPage("active");
    await slot.findByText("5 agents across 3 tasks");
    expect(await slot.findAllByRole("button", { name: /Open thread/ })).toHaveLength(5);
    expect(slot.getAllByText("TSK-1").length).toBeGreaterThan(0);
    expect(slot.getByText("Implementing")).toBeDefined();
    expect(slot.getByText("Queued worker")).toBeDefined();
    expect(slot.getByText("Idle worker")).toBeDefined();
    expect(slot.getByText("Lost worker")).toBeDefined();
    expect(slot.getByText("Held worker")).toBeDefined();
    expect(slot.getByText("GLM-4.6")).toBeDefined();
    expect(slot.getAllByText("Model unknown")).toHaveLength(2);
  });

  it("keeps the sidebar Active badge equal to the agent row count", async () => {
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "all" },
      { rpc: agentsRpc },
    );
    await slot.findByText("Tasks Plugin");
    expect(slot.getByText("5")).toBeDefined();
  });

  it("opens the exact BB thread from a row's working control", async () => {
    const slot = openAgentsPage("active");
    const buttons = await slot.findAllByRole("button", { name: /Open thread/ });
    expect(buttons).toHaveLength(5);
    fireEvent.click(buttons[0]!);
    expect(slot.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "thr_run01",
    });
  });

  it("narrows with search without dropping the total from the label", async () => {
    const slot = openAgentsPage("active");
    await slot.findByText("5 agents across 3 tasks");
    fireEvent.input(slot.getByLabelText("Search agents"), {
      target: { value: "Implementing" },
    });
    expect(slot.getByText("1 agents across 1 tasks")).toBeDefined();
    expect(slot.getByText("of 5 total")).toBeDefined();
    expect(slot.getByText("Implementing")).toBeDefined();
    expect(slot.queryByText("Queued worker")).toBeNull();
  });

  it("shows only positively running agents on Running", async () => {
    const slot = openAgentsPage("running");
    await slot.findByText("1 agents running across 1 tasks");
    expect(slot.getByText("Implementing")).toBeDefined();
    expect(slot.queryByText("Queued worker")).toBeNull();
    expect(slot.queryByText("Idle worker")).toBeNull();
  });

  it("shows only evidenced blockers on Blocked and counts cards separately", async () => {
    const slot = openAgentsPage("blocked");
    await slot.findByText("1 blocked agents across 1 tasks");
    expect(slot.getByText("Held worker")).toBeDefined();
    expect(slot.getByText("Waiting for approval")).toBeDefined();
    expect(slot.queryByText("Implementing")).toBeNull();
    expect(slot.queryByText("Lost worker")).toBeNull();
  });

  it("keeps the blocked-scope note visible so threadless cards are not claimed", async () => {
    const slot = openAgentsPage("blocked");
    await slot.findByText(/thread evidence only/);
  });

  it("filters agents to one project without dropping the total from the label", async () => {
    const slot = openAgentsPage("active");
    await slot.findByText("5 agents across 3 tasks");
    fireEvent.click(slot.getByRole("combobox", { name: "Filter by project" }));
    fireEvent.click(await slot.findByRole("option", { name: "Tasks Plugin" }));
    expect(slot.getByText("4 agents across 2 tasks")).toBeDefined();
    expect(slot.getByText("of 5 total")).toBeDefined();
    expect(slot.queryByText("Held worker")).toBeNull();
  });
});
