import { timingSafeEqual } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readOrCreateSecretFile } from "@bb/secret-storage";
import type { Context } from "hono";

export const OPERATOR_TOKEN_HEADER = "x-bb-operator-token";
export const OPERATOR_TOKEN_FILE_NAME = "operator-token";
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

export interface OperatorTokenSource {
  dataDir: string;
  /** Operator-issued token file (BB_OPERATOR_TOKEN_FILE). Read-only on
   *  purpose: the operator issues and rotates the token, so a missing,
   *  empty or unreadable file refuses operator-reserved mutations — the
   *  server never mints a replacement the operator does not know. */
  tokenFile?: string;
}

export async function resolveOperatorToken(
  source: OperatorTokenSource,
): Promise<string> {
  if (source.tokenFile !== undefined) {
    let raw: string;
    try {
      raw = await readFile(source.tokenFile, "utf8");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `the operator token file ${source.tokenFile} could not be read (${reason}) — ` +
          "issue the token there yourself; BB_OPERATOR_TOKEN_FILE is never minted or replaced by the server",
      );
    }
    const token = raw.trim();
    if (token.length === 0) {
      throw new Error(
        `the operator token file ${source.tokenFile} is empty — issue the token there yourself; ` +
          "BB_OPERATOR_TOKEN_FILE is never minted or replaced by the server",
      );
    }
    return token;
  }
  return readOrCreateSecretFile({
    bytes: 32,
    dataDir: source.dataDir,
    encoding: "hex",
    fileName: OPERATOR_TOKEN_FILE_NAME,
  });
}

export async function readOrCreateOperatorToken(dataDir: string): Promise<string> {
  return resolveOperatorToken({ dataDir });
}

export function operatorTokenSourceUnavailableError(reason: string): string {
  return (
    "operator authentication is unavailable — the operator token source could not be read, " +
    `so operator-reserved surfaces refuse every caller. Restore the operator-issued token source and retry: ${reason}`
  );
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
