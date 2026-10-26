import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { applyDefense, resolveDefensePolicy } from "./defense";

// Synthetic credentials — shaped like the real thing, not the real thing.
const OPENAI_KEY = "sk-" + "a".repeat(24);
const ANTHROPIC_KEY = "sk-ant-" + "b".repeat(24);
const AWS_KEY = "AKIA" + "C".repeat(16);
const GITHUB_TOKEN = "ghp_" + "d".repeat(32);
const TEST_JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["ZO_MEMORY_DEFENSE", "ZO_MEMORY_DEFENSE_PII"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("applyDefense", () => {
  test("redacts an OpenAI-style API key by default", () => {
    const r = applyDefense(`my key is ${OPENAI_KEY} ok`);
    expect(r.findings.map((f) => f.pattern)).toContain("openai_api_key");
    expect(r.text).toContain("[REDACTED:openai_api_key]");
    expect(r.text).not.toContain(OPENAI_KEY);
    expect(r.blocked).toBe(false);
  });

  test("an Anthropic key is not double-reported as an OpenAI key", () => {
    const r = applyDefense(`token: ${ANTHROPIC_KEY}`);
    const names = r.findings.map((f) => f.pattern);
    expect(names).toContain("anthropic_api_key");
    expect(names).not.toContain("openai_api_key");
  });

  test("redacts AWS access key ids and GitHub tokens", () => {
    const r = applyDefense(`aws ${AWS_KEY} gh ${GITHUB_TOKEN}`);
    const names = r.findings.map((f) => f.pattern);
    expect(names).toContain("aws_access_key_id");
    expect(names).toContain("github_token");
    expect(r.text).not.toContain(AWS_KEY);
    expect(r.text).not.toContain(GITHUB_TOKEN);
  });

  test("redacts Google keys in both the AIza and the current AQ. format, and Synthetic syn_ keys", () => {
    const AIZA = "AIza" + "e".repeat(35);
    const AQ = "AQ.Ab8" + "f".repeat(47);
    const SYN = "syn_" + "g".repeat(32);
    const r = applyDefense(`gemini ${AIZA} and ${AQ}; synthetic ${SYN}`);
    const names = r.findings.map((f) => f.pattern);
    expect(names).toContain("google_api_key");
    expect(names).toContain("google_auth_key");
    expect(names).toContain("synthetic_api_key");
    for (const k of [AIZA, AQ, SYN]) expect(r.text).not.toContain(k);
    expect(applyDefense("see section AQ.4 of the spec").findings).toHaveLength(0);
  });

  test("redacts private key block headers and JWTs", () => {
    const r = applyDefense(`-----BEGIN OPENSSH PRIVATE KEY----- and ${TEST_JWT}`);
    const names = r.findings.map((f) => f.pattern);
    expect(names).toContain("private_key_block");
    expect(names).toContain("jwt");
  });

  test("redacts connection strings and generic secret assignments (value only)", () => {
    const r = applyDefense(`db postgres://app:hunter2secret@db.internal:5432/main and password = hunter2secret`);
    const names = r.findings.map((f) => f.pattern);
    expect(names).toContain("connection_string");
    expect(names).toContain("generic_secret_assignment");
    expect(r.text).not.toContain("hunter2secret");
    // the key name survives; only the value is scrubbed
    expect(r.text).toContain("password =");
  });

  test("clean text passes through untouched with no findings", () => {
    const r = applyDefense("the router password policy was updated on tuesday");
    expect(r.findings).toHaveLength(0);
    expect(r.text).toBe("the router password policy was updated on tuesday");
  });

  test("block policy marks the write blocked and leaves text unchanged", () => {
    const r = applyDefense(`key ${OPENAI_KEY}`, { policy: "block" });
    expect(r.blocked).toBe(true);
    expect(r.text).toContain(OPENAI_KEY);
  });

  test("off policy skips scanning entirely", () => {
    const r = applyDefense(`key ${OPENAI_KEY}`, { policy: "off" });
    expect(r.findings).toHaveLength(0);
    expect(r.text).toContain(OPENAI_KEY);
  });

  test("PII patterns are opt-in via ZO_MEMORY_DEFENSE_PII=1", () => {
    const text = "contact 123-45-6789 or test@example.com";
    const off = applyDefense(text);
    expect(off.findings).toHaveLength(0);
    const on = applyDefense(text, { includePii: true });
    const names = on.findings.map((f) => f.pattern);
    expect(names).toContain("us_ssn");
    expect(names).toContain("email_address");
    expect(on.text).not.toContain("123-45-6789");
  });

  test("credit cards require a Luhn-valid number", () => {
    const valid = applyDefense("card 4111 1111 1111 1111", { includePii: true });
    expect(valid.findings.map((f) => f.pattern)).toContain("credit_card");
    const invalid = applyDefense("card 4111 1111 1111 1112", { includePii: true });
    expect(invalid.findings.map((f) => f.pattern)).not.toContain("credit_card");
  });
});

describe("resolveDefensePolicy", () => {
  test("defaults to redact", () => {
    expect(resolveDefensePolicy({}).policy).toBe("redact");
  });

  test("unrecognized policy strings fail safe to redact, never off", () => {
    expect(resolveDefensePolicy({ ZO_MEMORY_DEFENSE: "banana" }).policy).toBe("redact");
    expect(resolveDefensePolicy({ ZO_MEMORY_DEFENSE: "" }).policy).toBe("redact");
  });

  test("block and off are honored when explicitly set", () => {
    expect(resolveDefensePolicy({ ZO_MEMORY_DEFENSE: "block" }).policy).toBe("block");
    expect(resolveDefensePolicy({ ZO_MEMORY_DEFENSE: "off" }).policy).toBe("off");
  });
});
