import { describe, expect, test } from "bun:test";
import {
  createZoMcpListPersonasCaller,
  extractPersonaText,
  hashSnapshot,
  normalizeSnapshot,
  parseListPersonasResponse,
  parsePythonReprPersona,
  resolveAgainstSnapshot,
  resolvePersonas,
  resolveZoMcpAuthorization,
  type PersonaAssociationRole,
  type ZoPersonaDirectoryEntry,
} from "./persona-directory";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMcpResponse(reprs: string[]): unknown {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify(reprs) }],
    },
  };
}

function makePersona(overrides: Partial<ZoPersonaDirectoryEntry>): ZoPersonaDirectoryEntry {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    name: "Test",
    model: null,
    scopes: ["all"],
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const ALARIC_REPR =
  "id='9fa5bf37-8fdb-4172-80f0-1bc48eda8911' name='Alaric' prompt='You are a J.A.R.V.I.S.-inspired AI.\\n\\nRefer to yourself as Alaric.' model='byok:63a73cf2-224a-4641-8dcb-c3313270d08a' image=None image_hue=None scopes=['all'] file_permissions=[] is_default=False created_at=datetime.datetime(2025, 12, 29, 20, 4, 27, 790734, tzinfo=datetime.timezone.utc) updated_at=datetime.datetime(2026, 7, 31, 3, 5, 40, 54208, tzinfo=datetime.timezone.utc)";

const FRONTEND_REPR =
  "id='2bf315cc-df19-4ab8-a756-b9521f954c38' name='Frontend Developer' prompt='You are **Frontend Developer**.' model='byok:63a73cf2-224a-4641-8dcb-c3313270d08a' image=None image_hue=None scopes=['all'] file_permissions=[] is_default=False created_at=datetime.datetime(2026, 1, 19, 22, 0, 41, 450443, tzinfo=datetime.timezone.utc) updated_at=datetime.datetime(2026, 6, 11, 21, 46, 5, 222473, tzinfo=datetime.timezone.utc)";

const NO_MODEL_REPR =
  "id='3d488f60-69f6-4101-82d6-a244afd631a7' name='Backend Architect' prompt='You are **Backend Architect**.' model=None image=None image_hue=None scopes=['files:read', 'code:read'] file_permissions=[] is_default=False created_at=datetime.datetime(2026, 1, 19, 22, 0, 41, 453452, tzinfo=datetime.timezone.utc) updated_at=datetime.datetime(2026, 1, 19, 22, 0, 41, 453452, tzinfo=datetime.timezone.utc)";

// ── Parser tests ────────────────────────────────────────────────────────────

describe("native VPS directory records", () => {
  const native = {
    schema: "native-persona-directory/v1",
    personas: [{
      id: "native:factory:testing-reality-checker:v1",
      name: "Testing Reality Checker",
      model: null,
      scopes: ["files:read"],
      updated_at: "2026-09-25T00:00:00Z",
    }],
  };

  test("parses an exact structured identity without Zo repr", () => {
    expect(parseListPersonasResponse(native)).toEqual(native.personas);
  });

  test("rejects malformed and duplicate native identities", () => {
    expect(() => parseListPersonasResponse({
      ...native, personas: [{ ...native.personas[0], id: "zo-old-id" }],
    })).toThrow("invalid native persona entry");
    expect(() => parseListPersonasResponse({
      ...native, personas: [native.personas[0], { ...native.personas[0], name: "Second" }],
    })).toThrow("duplicate native persona identity");
    expect(() => parseListPersonasResponse({
      ...native, personas: [{ ...native.personas[0], scopes: ["files:read", "files:read"] }],
    })).toThrow("invalid native persona entry");
  });

  test("missing required reviewer remains a failure", async () => {
    const result = await resolvePersonas({
      mode: "enforce",
      roles: [{ role_id: "security", selector: "Security Engineer", required: true }],
      listPersonas: async () => native,
      timeoutMs: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.kind).toBe("missing");
  });
});

describe("extractPersonaText", () => {
  test("extracts text from full Zo MCP JSON-RPC response", () => {
    const raw = makeMcpResponse([ALARIC_REPR]);
    expect(extractPersonaText(raw)).toBe(JSON.stringify([ALARIC_REPR]));
  });

  test("extracts text from result.content[0].text directly", () => {
    const raw = { result: { content: [{ text: JSON.stringify([ALARIC_REPR]) }] } };
    expect(extractPersonaText(raw)).toBe(JSON.stringify([ALARIC_REPR]));
  });

  test("accepts a JSON-stringified array directly", () => {
    const raw = JSON.stringify([ALARIC_REPR]);
    expect(extractPersonaText(raw)).toBe(raw);
  });

  test("accepts a plain string array directly", () => {
    const raw = [ALARIC_REPR];
    expect(extractPersonaText(raw)).toBe(JSON.stringify(raw));
  });

  test("returns null for malformed shapes", () => {
    expect(extractPersonaText(null)).toBeNull();
    expect(extractPersonaText({})).toBeNull();
    expect(extractPersonaText({ result: { content: [] } })).toBeNull();
    expect(extractPersonaText({ result: { content: [{}] } })).toBeNull();
  });
});

describe("parsePythonReprPersona", () => {
  test("parses real platform repr including prompt without retaining it", () => {
    const entry = parsePythonReprPersona(ALARIC_REPR);
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe("9fa5bf37-8fdb-4172-80f0-1bc48eda8911");
    expect(entry!.name).toBe("Alaric");
    expect(entry!.model).toBe("byok:63a73cf2-224a-4641-8dcb-c3313270d08a");
    expect(entry!.scopes).toEqual(["all"]);
    expect(entry!.updated_at).toBe("2026-07-31T03:05:40.054208Z");
    expect((entry as unknown as Record<string, unknown>).prompt).toBeUndefined();
  });

  test("handles model=None", () => {
    const entry = parsePythonReprPersona(NO_MODEL_REPR);
    expect(entry).not.toBeNull();
    expect(entry!.model).toBeNull();
  });

  test("handles scopes lists other than ['all']", () => {
    const entry = parsePythonReprPersona(NO_MODEL_REPR);
    expect(entry).not.toBeNull();
    expect(entry!.scopes).toEqual(["files:read", "code:read"]);
  });

  test("handles escaped single quotes in names", () => {
    const repr =
      "id='a' name='O\\'Brien' prompt='x' model=None scopes=[] updated_at=None";
    const entry = parsePythonReprPersona(repr);
    expect(entry).not.toBeNull();
    expect(entry!.name).toBe("O'Brien");
  });

  test("ignores name= patterns inside the prompt", () => {
    const repr =
      "id='a' name='Real' prompt='Refer to name=\\'Fake\\'' model=None scopes=[] updated_at=None";
    const entry = parsePythonReprPersona(repr);
    expect(entry).not.toBeNull();
    expect(entry!.name).toBe("Real");
  });

  test("returns null for malformed repr", () => {
    expect(parsePythonReprPersona("not a persona")).toBeNull();
    expect(parsePythonReprPersona("name='Only'")).toBeNull();
  });
});

describe("parseListPersonasResponse", () => {
  test("parses the platform string-array/Python-repr shape", () => {
    const entries = parseListPersonasResponse(makeMcpResponse([ALARIC_REPR, FRONTEND_REPR]));
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.name)).toEqual(["Alaric", "Frontend Developer"]);
  });

  test("sorts entries deterministically by name then id", () => {
    const reprA = "id='b' name='Zulu' prompt='x' model=None scopes=[] updated_at=None";
    const reprB = "id='a' name='Alpha' prompt='x' model=None scopes=[] updated_at=None";
    const entries = parseListPersonasResponse([reprA, reprB]);
    expect(entries.map((e) => e.name)).toEqual(["Alpha", "Zulu"]);
  });

  test("drops malformed entries without failing", () => {
    const entries = parseListPersonasResponse(makeMcpResponse([ALARIC_REPR, "garbage"]));
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("Alaric");
  });

  test("returns empty array for non-JSON malformed text", () => {
    expect(parseListPersonasResponse(makeMcpResponse(["not valid"]))).toHaveLength(0);
  });

  test("returns empty array when response shape is wrong", () => {
    expect(parseListPersonasResponse({})).toHaveLength(0);
    expect(parseListPersonasResponse(null)).toHaveLength(0);
  });
});

// ── Snapshot hash tests ─────────────────────────────────────────────────────

describe("hashSnapshot", () => {
  test("is stable for identical entries", () => {
    const entries = [makePersona({ id: "a", name: "A" }), makePersona({ id: "b", name: "B" })];
    expect(hashSnapshot(entries)).toBe(hashSnapshot(entries));
  });

  test("is invariant to entry order", () => {
    const a = makePersona({ id: "a", name: "A", scopes: ["x", "y"] });
    const b = makePersona({ id: "b", name: "B", scopes: ["y", "x"] });
    const h1 = hashSnapshot([a, b]);
    const h2 = hashSnapshot([b, a]);
    expect(h1).toBe(h2);
  });

  test("scopes are sorted inside the hash", () => {
    const a = makePersona({ id: "a", name: "A", scopes: ["z", "a"] });
    const b = makePersona({ id: "a", name: "A", scopes: ["a", "z"] });
    expect(hashSnapshot([a])).toBe(hashSnapshot([b]));
  });

  test("changes when normalized fields change", () => {
    const base = makePersona({ id: "a", name: "A" });
    const changed = makePersona({ id: "a", name: "A-changed" });
    expect(hashSnapshot([base])).not.toBe(hashSnapshot([changed]));
  });

  test("normalizeSnapshot includes hash and timestamp", () => {
    const snapshot = normalizeSnapshot([makePersona({ id: "a", name: "A" })], "2026-08-10T09:00:00Z");
    expect(snapshot.snapshot_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.captured_at).toBe("2026-08-10T09:00:00Z");
  });
});

// ── Resolver tests ──────────────────────────────────────────────────────────

describe("resolveAgainstSnapshot", () => {
  const snapshot = normalizeSnapshot([
    makePersona({ id: "alaric-id", name: "Alaric", scopes: ["all"] }),
    makePersona({ id: "frontend-id", name: "Frontend Developer", scopes: ["all"] }),
    makePersona({ id: "backend-id", name: "Backend Architect", scopes: ["files:read", "code:read"] }),
    makePersona({ id: "dup1-id", name: "Duplicate" }),
    makePersona({ id: "dup2-id", name: "Duplicate" }),
    makePersona({ id: "renamed-id", name: "Old Name" }),
  ]);

  test("resolves exact required name", () => {
    const roles: PersonaAssociationRole[] = [
      { role_id: "advisor", selector: "Alaric", required: true },
    ];
    const result = resolveAgainstSnapshot({ mode: "enforce", roles, snapshot });
    expect(result.ok).toBe(true);
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].persona_id).toBe("alaric-id");
  });

  test("optional missing becomes omission, not failure", () => {
    const roles: PersonaAssociationRole[] = [
      { role_id: "ghost", selector: "Ghost Persona", required: false },
    ];
    const result = resolveAgainstSnapshot({ mode: "enforce", roles, snapshot });
    expect(result.ok).toBe(true);
    expect(result.omitted).toHaveLength(1);
    expect(result.omitted[0].reason).toContain("not found");
  });

  test("required missing fails closed", () => {
    const roles: PersonaAssociationRole[] = [
      { role_id: "ghost", selector: "Ghost Persona", required: true },
    ];
    const result = resolveAgainstSnapshot({ mode: "enforce", roles, snapshot });
    expect(result.ok).toBe(false);
    expect(result.failures[0].kind).toBe("missing");
  });

  test("detects duplicate exact names", () => {
    const roles: PersonaAssociationRole[] = [
      { role_id: "dup", selector: "Duplicate", required: true },
    ];
    const result = resolveAgainstSnapshot({ mode: "enforce", roles, snapshot });
    expect(result.ok).toBe(false);
    expect(result.failures[0].kind).toBe("duplicate");
    expect(result.failures[0].candidates).toEqual(["dup1-id", "dup2-id"]);
  });

  test("detects renamed personas via case-insensitive match", () => {
    const roles: PersonaAssociationRole[] = [
      { role_id: "legacy", selector: "old name", required: true },
    ];
    const result = resolveAgainstSnapshot({ mode: "enforce", roles, snapshot });
    expect(result.ok).toBe(false);
    expect(result.failures[0].kind).toBe("renamed");
    expect(result.failures[0].candidates).toEqual(["Old Name"]);
  });

  test("detects under-scoped personas", () => {
    const roles: PersonaAssociationRole[] = [
      { role_id: "backend", selector: "Backend Architect", required: true, required_scopes: ["code:write"] },
    ];
    const result = resolveAgainstSnapshot({ mode: "enforce", roles, snapshot });
    expect(result.ok).toBe(false);
    expect(result.failures[0].kind).toBe("under_scoped");
    expect(result.failures[0].missing_scopes).toEqual(["code:write"]);
  });

  test("scopes=['all'] satisfies any required scopes", () => {
    const roles: PersonaAssociationRole[] = [
      { role_id: "alaric", selector: "Alaric", required: true, required_scopes: ["anything"] },
    ];
    const result = resolveAgainstSnapshot({ mode: "enforce", roles, snapshot });
    expect(result.ok).toBe(true);
    expect(result.resolved).toHaveLength(1);
  });

  test("shadow mode records omissions, not failures", () => {
    const roles: PersonaAssociationRole[] = [
      { role_id: "ghost", selector: "Ghost Persona", required: true },
      { role_id: "dup", selector: "Duplicate", required: true },
    ];
    const result = resolveAgainstSnapshot({ mode: "shadow", roles, snapshot });
    expect(result.ok).toBe(true);
    expect(result.failures).toHaveLength(0);
    expect(result.omitted).toHaveLength(2);
    expect(result.would_invoke).toBe(true);
  });
});

// ── Async adapter tests ─────────────────────────────────────────────────────

describe("resolvePersonas", () => {
  test("off mode performs no call", async () => {
    let called = false;
    const result = await resolvePersonas({
      mode: "off",
      roles: [{ role_id: "x", selector: "Alaric", required: true }],
      listPersonas: async () => {
        called = true;
        return makeMcpResponse([ALARIC_REPR]);
      },
      timeoutMs: 1000,
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.snapshot).toBeNull();
  });

  test("enforce mode resolves a live-style response", async () => {
    const result = await resolvePersonas({
      mode: "enforce",
      roles: [
        { role_id: "advisor", selector: "Alaric", required: true },
        { role_id: "implementer", selector: "Frontend Developer", required: true },
      ],
      listPersonas: async () => makeMcpResponse([ALARIC_REPR, FRONTEND_REPR]),
      timeoutMs: 1000,
      now: "2026-08-10T09:00:00Z",
    });
    expect(result.ok).toBe(true);
    expect(result.resolved).toHaveLength(2);
    expect(result.snapshot?.snapshot_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.snapshot?.captured_at).toBe("2026-08-10T09:00:00Z");
  });

  test("timeout fails closed in enforce mode", async () => {
    const result = await resolvePersonas({
      mode: "enforce",
      roles: [{ role_id: "x", selector: "Alaric", required: true }],
      listPersonas: async () => {
        await new Promise((r) => setTimeout(r, 5000));
        return makeMcpResponse([ALARIC_REPR]);
      },
      timeoutMs: 50,
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0].kind).toBe("unavailable");
    expect(result.failures[0].message).toContain("timed out");
  });

  test("timeout in shadow mode records would_invoke without failing", async () => {
    const result = await resolvePersonas({
      mode: "shadow",
      roles: [{ role_id: "x", selector: "Alaric", required: true }],
      listPersonas: async () => {
        await new Promise((r) => setTimeout(r, 5000));
        return makeMcpResponse([ALARIC_REPR]);
      },
      timeoutMs: 50,
    });
    expect(result.ok).toBe(true);
    expect(result.would_invoke).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  test("malformed directory response returns empty snapshot and fails enforce", async () => {
    const result = await resolvePersonas({
      mode: "enforce",
      roles: [{ role_id: "x", selector: "Alaric", required: true }],
      listPersonas: async () => ({ garbage: true }),
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0].kind).toBe("missing");
  });

  test("required and optional mixed resolution", async () => {
    const result = await resolvePersonas({
      mode: "enforce",
      roles: [
        { role_id: "required", selector: "Alaric", required: true },
        { role_id: "optional", selector: "Ghost", required: false },
      ],
      listPersonas: async () => makeMcpResponse([ALARIC_REPR]),
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(true);
    expect(result.resolved).toHaveLength(1);
    expect(result.omitted).toHaveLength(1);
  });
});

// ── Live caller wiring tests (no actual network call) ───────────────────────

describe("createZoMcpListPersonasCaller", () => {
  test("fails locally without authorization instead of sending an anonymous Zo request", async () => {
    let calls = 0;
    const caller = createZoMcpListPersonasCaller({ authorization: " ", fetch_impl: async () => {
      calls++; return new Response("{}");
    }});
    await expect(caller()).rejects.toThrow("Local persona files are not Zo directory identities");
    expect(calls).toBe(0);
  });
  test("prefers the host identity token over a configured API key", () => {
    expect(resolveZoMcpAuthorization({}, {
      ZO_CLIENT_IDENTITY_TOKEN: "valid-host-token",
      ZO_API_KEY: "stale-api-key",
    })).toBe("valid-host-token");
  });

  test("falls back to the API key when no host identity token exists", () => {
    expect(resolveZoMcpAuthorization({}, {
      ZO_API_KEY: "access-token",
    })).toBe("Bearer access-token");
  });

  test("returns a callable function", () => {
    const caller = createZoMcpListPersonasCaller({ endpoint: "http://localhost:1/mcp", apiKey: "x" });
    expect(typeof caller).toBe("function");
  });

  test("uses Bearer authentication for a Zo API key", async () => {
    let authorization: string | null = null;
    const caller = createZoMcpListPersonasCaller({
      endpoint: "https://example.invalid/mcp",
      apiKey: "access-token",
      fetch_impl: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return new Response(JSON.stringify(makeMcpResponse([ALARIC_REPR])), { status: 200 });
      },
    });
    await caller();
    expect(String(authorization)).toBe("Bearer access-token");
  });

  test("passes a Zo client identity authorization value without rewriting it", async () => {
    let authorization: string | null = null;
    const caller = createZoMcpListPersonasCaller({
      endpoint: "https://example.invalid/mcp",
      authorization: "client-identity-token",
      fetch_impl: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return new Response(JSON.stringify(makeMcpResponse([ALARIC_REPR])), { status: 200 });
      },
    });
    await caller();
    expect(String(authorization)).toBe("client-identity-token");
  });

  test("turns a JSON-RPC error into a directory-unavailable failure", async () => {
    const caller = createZoMcpListPersonasCaller({
      endpoint: "https://example.invalid/mcp",
      authorization: "client-identity-token",
      fetch_impl: async () => new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32001, message: "Authentication failed" },
      }), { status: 200 }),
    });
    await expect(caller()).rejects.toThrow("MCP -32001: Authentication failed");
  });
});
