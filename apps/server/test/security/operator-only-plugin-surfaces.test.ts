import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";
import {
  appendOperatorAudit,
  OPERATOR_AUDIT_FILE_NAME,
  operatorCallerFromRequest,
  operatorAuditFields,
  readOrCreateOperatorToken,
} from "../../src/operator-auth.js";

declare global {
  var __opOnlyMutations: number | undefined;
  var __legacyMutations: number | undefined;
}

const BASE = "http://127.0.0.1:3334";

const PLUGIN_SOURCE = `
  import { defineRpcContract } from "@get-bb/plugin-sdk";
  import { z } from "zod";
  const rpcContract = defineRpcContract({
    mutate: {
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string(), revision: z.number() }),
      operatorOnly: true,
    },
    read: {
      input: z.null(),
      output: z.object({ revision: z.number() }),
    },
  });
  export default function plugin(bb: any) {
    bb.rpc.register(rpcContract, {
      mutate: (input: any) => {
        globalThis.__opOnlyMutations = (globalThis.__opOnlyMutations ?? 0) + 1;
        return { value: input.value, revision: globalThis.__opOnlyMutations };
      },
      read: () => ({ revision: globalThis.__opOnlyMutations ?? 0 }),
    });
    bb.cli.register({
      name: "oponly",
      summary: "Operator gate fixture",
      experimental_operatorArgv: ["thing write"],
      commands: [
        { name: "thing", summary: "Read or write the fixture state", usage: "bb oponly thing write <v>" },
      ],
      run: (argv: string[]) => {
        if (argv[0] !== "thing") return { exitCode: 1, stderr: "unknown verb" };
        if (argv[1] === "write") {
          globalThis.__opOnlyMutations = (globalThis.__opOnlyMutations ?? 0) + 1;
          return { exitCode: 0, stdout: "written" };
        }
        return { exitCode: 0, stdout: String(globalThis.__opOnlyMutations ?? 0) };
      },
    });
  }
`;

const LEGACY_PLUGIN_SOURCE = `
  import { defineRpcContract } from "@get-bb/plugin-sdk";
  import { z } from "zod";
  const rpcContract = defineRpcContract({
    mutate: {
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string(), revision: z.number() }),
    },
  });
  export default function plugin(bb: any) {
    bb.rpc.register(rpcContract, {
      mutate: (input: any) => {
        globalThis.__legacyMutations = (globalThis.__legacyMutations ?? 0) + 1;
        return { value: input.value, revision: globalThis.__legacyMutations };
      },
    });
  }
`;

async function writePlugin(
  dir: string,
  options: { name: string; serverSource: string },
): Promise<string> {
  const { mkdir } = await import("node:fs/promises");
  const rootDir = join(dir, options.name);
  await mkdir(rootDir, { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: options.name,
      version: "0.1.0",
      bb: {
        name: "Operator gate fixture",
        description: "Operator gate fixture.",
        branding: { icon: "Lock" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), options.serverSource);
  return rootDir;
}

interface AuditRow {
  time: string;
  actor: string;
  surface: string;
  pluginId: string;
  action: string;
  outcome: string;
  fields?: string[];
  status?: number;
}

async function readAuditRows(dataDir: string): Promise<AuditRow[]> {
  let raw: string;
  try {
    raw = await readFile(join(dataDir, OPERATOR_AUDIT_FILE_NAME), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditRow);
}

function rpcRequest(
  harness: TestAppHarness,
  pluginId: string,
  method: string,
  input: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(harness.app.request(
    `${BASE}/api/v1/plugins/${pluginId}/rpc/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(input),
    },
  ));
}

function cliRequest(
  harness: TestAppHarness,
  pluginId: string,
  argv: string[],
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(harness.app.request(
    `${BASE}/api/v1/plugins/${pluginId}/cli`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ argv }),
    },
  ));
}

describe("operator-only plugin surfaces", () => {
  let harness: TestAppHarness;
  let token: string;

  beforeEach(async () => {
    globalThis.__opOnlyMutations = 0;
    globalThis.__legacyMutations = 0;
    harness = await createTestAppHarness({ devAppPort: 5173 });
    const rootDir = await writePlugin(
      join(harness.config.dataDir, "fixtures"),
      { name: "bb-plugin-oponly", serverSource: PLUGIN_SOURCE },
    );
    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status).toBe("running");
    token = await readOrCreateOperatorToken(harness.config.dataDir);
  });

  afterEach(async () => {
    await harness.pluginService.stop();
    await harness.cleanup();
  });

  it("lets the operator mutate over rpc and audits the allowed mutation", async () => {
    const response = await rpcRequest(harness, "oponly", "mutate", {
      value: "set-by-operator",
    }, { "x-bb-operator-token": token });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      result: { value: "set-by-operator", revision: 1 },
    });

    const rows = await readAuditRows(harness.config.dataDir);
    expect(rows).toContainEqual(
      expect.objectContaining({
        actor: "operator",
        surface: "plugin-rpc",
        pluginId: "oponly",
        action: "mutate",
        outcome: "allowed",
        fields: ["value"],
      }),
    );
  });

  it("refuses rpc mutation without the token and changes nothing", async () => {
    const before = await rpcRequest(harness, "oponly", "read", null);
    await expect(before.json()).resolves.toEqual({
      ok: true,
      result: { revision: 0 },
    });

    const response = await rpcRequest(harness, "oponly", "mutate", {
      value: "set-by-agent",
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "operator_auth_required" },
    });

    const after = await rpcRequest(harness, "oponly", "read", null);
    await expect(after.json()).resolves.toEqual({
      ok: true,
      result: { revision: 0 },
    });

    const rows = await readAuditRows(harness.config.dataDir);
    expect(rows).toContainEqual(
      expect.objectContaining({
        actor: "unauthenticated",
        surface: "plugin-rpc",
        pluginId: "oponly",
        action: "mutate",
        outcome: "refused",
        status: 403,
      }),
    );
  });

  it("refuses rpc mutation with a spoofed token or spoofed caller headers", async () => {
    const spoof = await rpcRequest(harness, "oponly", "mutate", {
      value: "spoofed",
    }, {
      "x-bb-operator-token": `${token.slice(0, -1)}0`,
      "x-bb-thread-id": "thr_operator",
      "x-bb-author": "operator",
      origin: BASE,
    });
    expect(spoof.status).toBe(403);
    expect(await rpcRequest(harness, "oponly", "read", null)).toBeInstanceOf(
      Response,
    );
    const after = await rpcRequest(harness, "oponly", "read", null);
    await expect(after.json()).resolves.toEqual({
      ok: true,
      result: { revision: 0 },
    });
  });

  it("keeps read/use rpc open to callers without the token", async () => {
    const response = await rpcRequest(harness, "oponly", "read", null);
    expect(response.status).toBe(200);
    const rows = await readAuditRows(harness.config.dataDir);
    expect(
      rows.filter((row) => row.action === "read"),
    ).toHaveLength(0);
  });

  it("gates operator-only cli argv and audits allowed and refused runs", async () => {
    const refused = await cliRequest(harness, "oponly", [
      "thing",
      "write",
      "x",
    ]);
    expect(refused.status).toBe(403);

    const allowed = await cliRequest(harness, "oponly", [
      "thing",
      "write",
      "x",
    ], { "x-bb-operator-token": token });
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({ exitCode: 0 });

    const open = await cliRequest(harness, "oponly", ["thing", "read"]);
    expect(open.status).toBe(200);

    const rows = await readAuditRows(harness.config.dataDir);
    expect(rows).toContainEqual(
      expect.objectContaining({
        actor: "unauthenticated",
        surface: "plugin-cli",
        action: "thing write x",
        outcome: "refused",
        status: 403,
      }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        actor: "operator",
        surface: "plugin-cli",
        action: "thing write x",
        outcome: "allowed",
      }),
    );
  });

  it("keeps enforcement across a plugin reload", async () => {
    await expect(
      harness.pluginService.reload("oponly"),
    ).resolves.toMatchObject({ ok: true });

    const response = await rpcRequest(harness, "oponly", "mutate", {
      value: "after-reload",
    });
    expect(response.status).toBe(403);
    const allowed = await rpcRequest(harness, "oponly", "mutate", {
      value: "after-reload",
    }, { "x-bb-operator-token": token });
    expect(allowed.status).toBe(200);
  });

  it("treats a plugin without declarations as unguarded (rollback behavior)", async () => {
    const rootDir = await writePlugin(
      join(harness.config.dataDir, "fixtures"),
      { name: "bb-plugin-oplegacy", serverSource: LEGACY_PLUGIN_SOURCE },
    );
    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status).toBe("running");

    const response = await rpcRequest(harness, "oplegacy", "mutate", {
      value: "legacy",
    });
    expect(response.status).toBe(200);
    const rows = await readAuditRows(harness.config.dataDir);
    expect(
      rows.filter((row) => row.pluginId === "oplegacy"),
    ).toHaveLength(0);
  });

  it("writes a secret-free audit trail", async () => {
    await rpcRequest(harness, "oponly", "mutate", { value: token });
    const raw = await readFile(
      join(harness.config.dataDir, OPERATOR_AUDIT_FILE_NAME),
      "utf8",
    );
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(token.slice(0, 8));
  });
});

describe("operator auth helpers", () => {
  it("compares presented tokens timing-safely and tolerates whitespace", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dataDir = await mkdtemp(join(tmpdir(), "bb-operator-auth-test-"));
    const value = await readOrCreateOperatorToken(dataDir);
    const callerWithHeader = (presented: string | undefined) =>
      operatorCallerFromRequest(
        { req: { header: () => presented } } as unknown as Parameters<
          typeof operatorCallerFromRequest
        >[0],
        value,
      );
    expect(callerWithHeader(`  ${value} `)).toBe("operator");
    expect(callerWithHeader(undefined)).toBe("unauthenticated");
    expect(callerWithHeader("abc")).toBe("unauthenticated");
    await appendOperatorAudit(dataDir, {
      time: "2026-01-01T00:00:00.000Z",
      actor: "unauthenticated",
      surface: "plugin-rpc",
      pluginId: "p",
      action: "m",
      outcome: "refused",
      fields: operatorAuditFields({ presetId: "preset_x", other: 1 }),
      status: 403,
    });
    const rows = await readAuditRows(dataDir);
    expect(rows.at(-1)).toMatchObject({ pluginId: "p", outcome: "refused" });
  });
});
