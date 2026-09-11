import { timingSafeEqual } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { readOrCreateSecretFile } from "@bb/secret-storage";
import type { Context } from "hono";

export const OPERATOR_TOKEN_HEADER = "x-bb-operator-token";
const OPERATOR_TOKEN_FILE_NAME = "operator-token";
export const OPERATOR_AUDIT_FILE_NAME = "operator-audit.jsonl";

export type RequestCallerAuth = "operator" | "unauthenticated";

export type OperatorAuditSurface = "plugin-rpc" | "plugin-cli";

export interface OperatorAuditEntry {
  time: string;
  actor: RequestCallerAuth;
  surface: OperatorAuditSurface;
  pluginId: string;
  action: string;
  outcome: "allowed" | "refused";
  fields?: string[];
  status?: number;
}

export async function readOrCreateOperatorToken(dataDir: string): Promise<string> {
  return readOrCreateSecretFile({
    bytes: 32,
    dataDir,
    encoding: "hex",
    fileName: OPERATOR_TOKEN_FILE_NAME,
  });
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

export function operatorCallerFromRequest(
  context: Pick<Context, "req">,
  expectedToken: string,
): RequestCallerAuth {
  const presented = context.req.header(OPERATOR_TOKEN_HEADER)?.trim() ?? "";
  return presented.length > 0 && timingSafeEqualStrings(presented, expectedToken)
    ? "operator"
    : "unauthenticated";
}

export function operatorAuthRequiredError(): string {
  return (
    "operator authentication required — preset changes are reserved for the operator. " +
    `Send the server's operator token as the "${OPERATOR_TOKEN_HEADER}" header ` +
    "(data dir file operator-token; the bb app stores it under Settings → Operator access, " +
    "the bb CLI reads BB_OPERATOR_TOKEN)."
  );
}

export async function appendOperatorAudit(
  dataDir: string,
  entry: OperatorAuditEntry,
): Promise<void> {
  await appendFile(
    join(dataDir, OPERATOR_AUDIT_FILE_NAME),
    `${JSON.stringify(entry)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

export function operatorAuditFields(input: unknown): string[] | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  return Object.keys(input).sort();
}
