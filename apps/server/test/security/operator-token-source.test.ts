import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";
import {
  OPERATOR_AUDIT_FILE_NAME,
  OPERATOR_TOKEN_FILE_NAME,
  resolveOperatorToken,
} from "../../src/operator-auth.js";

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
        globalThis.__opTokenMutations = (globalThis.__opTokenMutations ?? 0) + 1;
        return { value: input.value, revision: globalThis.__opTokenMutations };
      },
      read: () => ({ revision: globalThis.__opTokenMutations ?? 0 }),
    });
  }
`;

async function writePlugin(
  dir: string,
  options: { name: string; serverSource: string },
): Promise<string> {
  const { writeFile: write } = await import("node:fs/promises");
  const rootDir = join(dir, options.name);
  await mkdir(rootDir, { recursive: true });
  await write(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: options.name,
      version: "0.1.0",
      bb: {
        name: "Token source fixture",
        description: "Token source fixture.",
        branding: { icon: "Lock" },
        server: "./server.ts",
      },
    }),
  );
  await write(join(rootDir, "server.ts"), options.serverSource);
  return rootDir;
}

declare global {
  var __opTokenMutations: number | undefined;
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

interface AuditRow {
  actor: string;
  surface: string;
  pluginId: string;
  action: string;
  outcome: string;
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

describe("operator token source", () => {
  let harness: TestAppHarness;
  let tokenFile: string;
  let token: string;

  beforeEach(async () => {
    globalThis.__opTokenMutations = 0;
    const issuedDir = await mkdtemp(join(tmpdir(), "bb-operator-issue-"));
    tokenFile = join(issuedDir, "operator-issued.token");
    token = "a".repeat(64);
    await writeFile(tokenFile, ` ${token}\n`, { mode: 0o600 });
    harness = await createTestAppHarness({ operatorTokenFile: tokenFile });
    const rootDir = await writePlugin(
      join(harness.config.dataDir, "fixtures"),
      { name: "bb-plugin-opsource", serverSource: PLUGIN_SOURCE },
    );
    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status).toBe("running");
  });

  afterEach(async () => {
    await harness.pluginService.stop();
    const issuedDir = dirname(tokenFile);
    await harness.cleanup();
    await rm(issuedDir, { recursive: true, force: true });
  });

  it("reads the operator-issued token and keeps the data-dir default out of the picture", async () => {
    await expect(resolveOperatorToken({ dataDir: harness.config.dataDir, tokenFile })).resolves.toBe(token);
    expect(existsSync(join(harness.config.dataDir, OPERATOR_TOKEN_FILE_NAME))).toBe(false);
  });

  it("denies a worker that cannot obtain the credential and fails closed while the file is unreadable", async () => {
    await chmod(tokenFile, 0o000);

    const denied = await rpcRequest(harness, "opsource", "mutate", {
      value: "set-by-worker",
    });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "operator_auth_required",
        message: expect.stringContaining("could not be read"),
      },
    });

    let theftError: NodeJS.ErrnoException | undefined;
    try {
      await readFile(tokenFile, "utf8");
    } catch (error) {
      theftError = error as NodeJS.ErrnoException;
    }
    expect(theftError?.code).toBe("EACCES");

    await expect(
      rpcRequest(harness, "opsource", "read", null),
    ).resolves.toMatchObject({ status: 200 });

    const rows = await readAuditRows(harness.config.dataDir);
    expect(rows).toContainEqual(
      expect.objectContaining({
        actor: "unauthenticated",
        surface: "plugin-rpc",
        pluginId: "opsource",
        action: "mutate",
        outcome: "refused",
        status: 403,
      }),
    );
    expect(
      existsSync(join(harness.config.dataDir, OPERATOR_TOKEN_FILE_NAME)),
    ).toBe(false);

    await chmod(tokenFile, 0o600);
    const stillDenied = await rpcRequest(harness, "opsource", "mutate", {
      value: "set-by-worker",
    }, {});
    expect(stillDenied.status).toBe(403);

    const operator = await rpcRequest(harness, "opsource", "mutate", {
      value: "set-by-operator",
    }, { "x-bb-operator-token": token });
    expect(operator.status).toBe(200);
    await expect(operator.json()).resolves.toEqual({
      ok: true,
      result: { value: "set-by-operator", revision: 1 },
    });
    const rowsAfterOperator = await readAuditRows(harness.config.dataDir);
    expect(rowsAfterOperator).toContainEqual(
      expect.objectContaining({
        actor: "operator",
        surface: "plugin-rpc",
        pluginId: "opsource",
        action: "mutate",
        outcome: "allowed",
      }),
    );
  });

  it("treats the configured file as operator-issued — missing or empty is never replaced", async () => {
    const missingPath = join(dirname(tokenFile), "missing.token");
    await expect(
      resolveOperatorToken({ dataDir: harness.config.dataDir, tokenFile: missingPath }),
    ).rejects.toThrow(/never minted or replaced/);
    await expect(
      resolveOperatorToken({ dataDir: harness.config.dataDir, tokenFile: missingPath }),
    ).rejects.toThrow(/could not be read/);

    const emptyPath = join(dirname(tokenFile), "empty.token");
    await writeFile(emptyPath, "  \n", { mode: 0o600 });
    await expect(
      resolveOperatorToken({ dataDir: harness.config.dataDir, tokenFile: emptyPath }),
    ).rejects.toThrow(/is empty/);
    await rm(emptyPath, { force: true });

    expect(existsSync(missingPath)).toBe(false);
    expect(existsSync(join(harness.config.dataDir, OPERATOR_TOKEN_FILE_NAME))).toBe(false);
  });

  it("never downgrades to a data-dir token while a file is configured", async () => {
    const { writeFile: write } = await import("node:fs/promises");
    const dataDirToken = "b".repeat(64);
    await write(join(harness.config.dataDir, OPERATOR_TOKEN_FILE_NAME), `${dataDirToken}\n`, { mode: 0o600 });

    const withDataDirToken = await rpcRequest(harness, "opsource", "mutate", {
      value: "set-by-worker",
    }, { "x-bb-operator-token": dataDirToken });
    expect(withDataDirToken.status).toBe(403);

    const withIssuedToken = await rpcRequest(harness, "opsource", "mutate", {
      value: "set-by-operator",
    }, { "x-bb-operator-token": token });
    expect(withIssuedToken.status).toBe(200);
  });
});
