import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";
import {
  OPERATOR_AUDIT_FILE_NAME,
  resolveOperatorToken,
} from "../../src/operator-auth.js";

const BASE = "http://127.0.0.1:3334";

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

function rpc(
  harness: TestAppHarness,
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(harness.app.request(
    `${BASE}/api/v1/plugins/tasks/rpc/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
  ));
}

describe("operator gate over the real Tasks plugin RPC", () => {
  let harness: TestAppHarness;
  let token: string;

  beforeEach(async () => {
    harness = await createTestAppHarness({});
    const entry = await harness.pluginService.installOfficialPlugin("tasks");
    expect(entry.status).toBe("running");
    token = await resolveOperatorToken({ dataDir: harness.config.dataDir });
  }, 120_000);

  afterEach(async () => {
    await harness.pluginService.stop();
    await harness.cleanup();
  });

  it("pins the endpoint, header, and 403/200 bodies the isolation verifier relies on", { timeout: 120_000 }, async () => {
    const createBody = {
      name: "operator-isolation-verify",
      providerId: "claude-code",
      modelId: "claude-haiku-4-5-20251001",
      reasoningLevel: "medium",
      permissionMode: "accept-edits",
    };

    const list = await rpc(harness, "listPresets", null);
    expect(list.status).toBe(200);

    const noToken = await rpc(harness, "createPreset", createBody);
    expect(noToken.status).toBe(403);
    await expect(noToken.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "operator_auth_required" },
    });

    const spoofed = await rpc(harness, "createPreset", createBody, {
      "x-bb-operator-token": "0".repeat(64),
    });
    expect(spoofed.status).toBe(403);
    await expect(spoofed.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "operator_auth_required" },
    });

    const allowed = await rpc(harness, "createPreset", createBody, {
      "x-bb-operator-token": token,
    });
    expect(allowed.status).toBe(200);
    const allowedBody = (await allowed.json()) as {
      ok: boolean;
      result: { preset: { id: string; name: string } };
    };
    expect(allowedBody).toMatchObject({
      ok: true,
      result: { preset: { name: "operator-isolation-verify" } },
    });
    expect(typeof allowedBody.result.preset.id).toBe("string");

    const removed = await rpc(harness, "deletePreset", {
      presetId: allowedBody.result.preset.id,
    }, { "x-bb-operator-token": token });
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toMatchObject({
      ok: true,
      result: { deleted: true },
    });

    const rows = await readAuditRows(harness.config.dataDir);
    const gateRows = rows.filter(
      (row) => row.pluginId === "tasks" && row.action === "createPreset",
    );
    expect(gateRows).toContainEqual(
      expect.objectContaining({
        actor: "unauthenticated",
        surface: "plugin-rpc",
        outcome: "refused",
        status: 403,
      }),
    );
    expect(gateRows).toContainEqual(
      expect.objectContaining({
        actor: "operator",
        surface: "plugin-rpc",
        outcome: "allowed",
      }),
    );
    expect(JSON.stringify(rows)).not.toContain(token);
  });
});
