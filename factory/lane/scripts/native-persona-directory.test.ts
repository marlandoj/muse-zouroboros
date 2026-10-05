import { createHash } from "node:crypto";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createNativePersonaDirectoryCaller } from "./native-persona-directory";
import { parseListPersonasResponse } from "./persona-directory";

const roots: string[] = [];
const priorMode = process.env.FACTORY_STATE_MODE;

afterEach(() => {
  for (const root of roots.splice(0)) {
    unlinkSync(join(root, "personas.json"));
    rmdirSync(root);
  }
  if (priorMode === undefined) delete process.env.FACTORY_STATE_MODE;
  else process.env.FACTORY_STATE_MODE = priorMode;
});

function fixture(personas: unknown): { path: string; digest: string } {
  process.env.FACTORY_STATE_MODE = "test";
  const root = mkdtempSync(join(tmpdir(), "native-persona-"));
  roots.push(root);
  const path = join(root, "personas.json");
  const bytes = JSON.stringify({ personas, schema: "native-persona-directory/v1" }) + "\n";
  writeFileSync(path, bytes);
  return { path, digest: createHash("sha256").update(bytes).digest("hex") };
}

const reviewer = {
  id: "native:factory:testing-reality-checker:v1",
  model: null,
  name: "Testing Reality Checker",
  scopes: ["files:read"],
  updated_at: "2026-09-25T00:00:00Z",
};

describe("pinned native persona directory", () => {
  test("returns an exact local identity without invoking a model", async () => {
    const { path, digest } = fixture([reviewer]);
    const raw = await createNativePersonaDirectoryCaller({ path, expectedSha256: digest })();
    expect(parseListPersonasResponse(raw)).toEqual([reviewer]);
  });

  test("rejects changed bytes and malformed reviewer records", async () => {
    const { path, digest } = fixture([reviewer]);
    writeFileSync(path, JSON.stringify({ personas: [], schema: "native-persona-directory/v1" }) + "\n");
    await expect(createNativePersonaDirectoryCaller({ path, expectedSha256: digest })())
      .rejects.toThrow("digest drift");
    const malformed = fixture([{ ...reviewer, id: "old-zo-id" }]);
    await expect(createNativePersonaDirectoryCaller({
      path: malformed.path, expectedSha256: malformed.digest,
    })()).rejects.toThrow("invalid native persona entry");
    const wrongSchema = fixture([]);
    const altered = JSON.stringify({ personas: [], schema: "native-persona-directory/v2" }) + "\n";
    writeFileSync(wrongSchema.path, altered);
    await expect(createNativePersonaDirectoryCaller({
      path: wrongSchema.path,
      expectedSha256: createHash("sha256").update(altered).digest("hex"),
    })()).rejects.toThrow("unexpected native persona directory schema");
  });

  test("requires a reviewed digest and refuses production path overrides", () => {
    process.env.FACTORY_STATE_MODE = "test";
    expect(() => createNativePersonaDirectoryCaller({ expectedSha256: "wrong" }))
      .toThrow("reviewed native directory digest required");
    delete process.env.FACTORY_STATE_MODE;
    expect(() => createNativePersonaDirectoryCaller({
      path: "/tmp/personas.json", expectedSha256: "a".repeat(64),
    })).toThrow("test-only");
  });
});
