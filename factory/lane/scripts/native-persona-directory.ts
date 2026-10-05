/** Read a pinned VPS persona directory. This grants no model invocation. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { parseListPersonasResponse } from "./persona-directory";

const PRODUCTION_PATH = "/etc/zouroboros/factory-personas.json";
const MAX_BYTES = 64 * 1024;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("invalid native persona JSON value");
  return serialized;
}

function trustedPath(path: string, fixture: boolean): void {
  let current = path;
  while (true) {
    const info = lstatSync(current);
    if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) {
      throw new Error("untrusted native persona path");
    }
    if (!fixture && (info.uid !== 0 || (info.mode & 0o022) !== 0)) {
      throw new Error("native persona path is not root controlled");
    }
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) break;
    current = parent;
  }
}

export function createNativePersonaDirectoryCaller(options: {
  expectedSha256: string;
  path?: string;
}): () => Promise<unknown> {
  if (!/^[a-f0-9]{64}$/.test(options.expectedSha256)) {
    throw new Error("reviewed native directory digest required");
  }
  const fixture = process.env.FACTORY_STATE_MODE === "test";
  if (options.path && !fixture) throw new Error("native persona path override is test-only");
  const path = resolve(options.path ?? PRODUCTION_PATH);
  if (!fixture && path !== PRODUCTION_PATH) throw new Error("unexpected native persona path");
  return async () => {
    trustedPath(path, fixture);
    const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = fstatSync(descriptor);
      if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_BYTES
          || !fixture && (before.uid !== 0 || (before.mode & 0o022) !== 0)) {
        throw new Error("untrusted native persona file");
      }
      const bytes = readFileSync(descriptor);
      const after = fstatSync(descriptor);
      const named = lstatSync(path);
      if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino
          || after.mtimeMs !== before.mtimeMs || after.size !== before.size
          || named.dev !== after.dev || named.ino !== after.ino) {
        throw new Error("native persona directory changed during read");
      }
      if (createHash("sha256").update(bytes).digest("hex") !== options.expectedSha256) {
        throw new Error("native persona directory digest drift");
      }
      const raw = bytes.toString("utf8");
      const value: unknown = JSON.parse(raw);
      if (raw !== canonical(value) + "\n") throw new Error("noncanonical native persona directory");
      if (!value || typeof value !== "object" || Array.isArray(value)
          || (value as Record<string, unknown>).schema !== "native-persona-directory/v1") {
        throw new Error("unexpected native persona directory schema");
      }
      parseListPersonasResponse(value); // fail closed before returning to the resolver
      return value;
    } finally {
      closeSync(descriptor);
    }
  };
}
