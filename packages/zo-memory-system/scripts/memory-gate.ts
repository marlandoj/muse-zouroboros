#!/usr/bin/env bun
/**
 * memory-gate.ts — Model-routed memory relevance filter
 * 
 * Takes a user message, uses the configured gate model to:
 * 1. Decide if the message needs memory context (yes/no)
 * 2. Extract search keywords if yes
 * 3. Runs memory hybrid search and outputs results
 * 
 * Exit codes:
 *   0 = memory results found and printed
 *   1 = error
 *   2 = no memory needed (message is trivial/greeting/etc)
 *   3 = memory needed but no results found
 */

import { detectContinuation } from "./continuation";
import { generate } from "./model-client";
import { extractWikilinks } from "./wikilink-utils";
import { getPersonaDomain } from "./domain-map.ts";
import { generateBriefing } from "./session-briefing.ts";
import { logGateDecision } from "./scorecard.ts";

const MEMORY_SCRIPT = "/home/workspace/Skills/zo-memory-system/scripts/memory.ts";
const MAX_RESULTS = 5;

interface GateResponse {
  needs_memory: boolean;
  keywords: string[];
  reason: string;
}

async function classifyMemoryNeed(message: string): Promise<GateResponse> {
  const prompt = `You are a classifier. Given a user message, decide if it would benefit from retrieving stored memory/context from previous conversations.

Answer ONLY with valid JSON, no other text.

Rules:
- Favor recall for ongoing or continuation-like work. Missing relevant prior context is worse than retrieving slightly extra context.
- Set "needs_memory": true when the message may plausibly continue prior work, ask for status/progress/results, reference an existing project/document/system, or use pronouns/ellipsis that imply prior context.
- Keep "needs_memory": false for clearly self-contained greetings, trivia, definitions, generic how-to questions, math, or standalone coding prompts.
- "keywords": 2-6 specific search terms extracted from the message (only if needs_memory is true, empty array otherwise). Never include generic words like "hello", "how", "what".
- "reason": one short sentence explaining your decision

Examples:
User: "hello"
{"needs_memory": false, "keywords": [], "reason": "Simple greeting"}

User: "update the supplier scorecard"
{"needs_memory": true, "keywords": ["supplier", "scorecard"], "reason": "Likely continuation of an existing workflow"}

User: "where did we leave off on the website review?"
{"needs_memory": true, "keywords": ["website", "review", "progress"], "reason": "Explicit continuation request"}

User: "check the current zo resources"
{"needs_memory": false, "keywords": [], "reason": "Self-contained system command"}

Now classify this message:
User: "${message.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;

  // Route through model-client: picks up ZO_MODEL_GATE from env, defaults to openai:gpt-4o-mini
  const result = await generate({
    prompt,
    workload: "gate",
  });

  const raw = result.content.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Failed to parse gate response as JSON: ${raw}`);
  }

  const parsed = JSON.parse(jsonMatch[0]);
  return {
    needs_memory: Boolean(parsed.needs_memory),
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
    reason: String(parsed.reason || ""),
  };
}

async function searchMemory(keywords: string[], preferExact: boolean = false): Promise<string> {
  const query = keywords.join(" ");
  const command = preferExact ? "search" : "hybrid";
  const extraArgs: string[] = [];
  const proc = Bun.spawn(
    ["bun", MEMORY_SCRIPT, command, query, "--limit", String(MAX_RESULTS), ...extraArgs],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  if (proc.exitCode !== 0 && !preferExact) {
    const ftsProc = Bun.spawn(
      ["bun", MEMORY_SCRIPT, "search", query, "--limit", String(MAX_RESULTS)],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const ftsOut = await new Response(ftsProc.stdout).text();
    await ftsProc.exited;
    return ftsOut.trim();
  }

  return stdout.trim();
}

async function searchContinuation(message: string): Promise<string> {
  const proc = Bun.spawn(
    ["bun", MEMORY_SCRIPT, "continuation", message, "--limit", String(MAX_RESULTS)],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout.trim();
}

// --- Exported module API (for inline import, no subprocess overhead) ---

export interface GateDecision {
  inject: boolean;
  method: string;
  latency_ms: number;
}

const KEYWORD_MEMORY_PATTERNS = [
  /\b(update|check|status|progress|continue|resume|review|where did we|left off|last time|remind|current|decided?)\b/i,
  /\b(project|system|config|persona|swarm|memory|episode|procedure)\./i,
  /\b(what happened|how is|show me|find)\b.*\b(with|about|for|in|doing|going)\b/i,
  /\b(remind me|what did we|where did we)\b/i,
];

const KEYWORD_SKIP_PATTERNS = [
  /^(hi|hello|hey|thanks|thank you|ok|sure|yes|no|bye|goodbye)\s*[!?.]*$/i,
  /^(what is|define|explain|how to|how do you)\s/i,
  /^\d+\s*[\+\-\*\/]\s*\d+/,
  /^good (morning|afternoon|evening)\b/i,
  /^(thanks|thank you) for\b/i,
  /^(write|create|build|implement|generate|code)\b.+\b(function|class|method|script|program|algorithm|component|module|app)\b/i,
];

/** Extract search keywords from a message by removing stop words */
function extractKeywordsFromMessage(message: string): string[] {
  const STOP_WORDS = new Set(["the","a","an","is","are","was","were","be","been","have","has","had","do","does","did","will","would","could","should","may","can","to","of","in","for","on","with","at","by","from","about","how","what","where","when","who","why","which","that","this","it","its","me","my","we","our","you","your","he","she","they","them","and","but","or","if","so","up","out","no","not","just","get","got","let","going","doing"]);
  return message
    .toLowerCase()
    .replace(/[?!.,;:'"]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

export function markBriefingInjected(): void {
  process.env.BRIEFING_INJECTED = "1";
}

/**
 * Generates and returns a session briefing for the given persona.
 * Call this once at conversation start (first user message) to inject
 * proactive PKA context. Sets BRIEFING_INJECTED flag so subsequent
 * shouldInjectMemory() calls skip redundant lookups.
 *
 * Returns null if persona is excluded or briefing generation fails.
 */
export async function injectSessionBriefing(personaSlug: string): Promise<string | null> {
  // No persona exclusions — CLI transports (claude-code, gemini-cli, codex-cli)
  // should never be passed here; the rule maps them to the intended persona (e.g., "alaric").
  // Hermes is excluded at the rule level (omits --persona flag).

  try {
    const domain = getPersonaDomain(personaSlug);
    const effectiveDomain = domain === "shared" || domain === "personal" ? undefined : domain;
    const result = await generateBriefing(personaSlug, effectiveDomain);

    if (!result.briefing || result.briefing.startsWith("No recent activity")) {
      return null;
    }

    // Set the flag so shouldInjectMemory() skips Tier 3 on the first message
    markBriefingInjected();

    // Format for injection into conversation context
    const parts: string[] = [
      `[Session Briefing — ${personaSlug}${effectiveDomain ? ` (${effectiveDomain})` : ""} — ${result.latency_ms}ms]`,
      result.briefing,
      `One Thing: ${result.one_thing}`,
    ];
    if (result.active_items.length > 0) {
      parts.push(`Open items: ${result.active_items.join("; ")}`);
    }
    if (result.inherited_facts.length > 0) {
      parts.push(`Cross-persona: ${result.inherited_facts.join("; ")}`);
    }

    return parts.join("\n");
  } catch {
    return null;
  }
}

export async function shouldInjectMemory(taskText: string): Promise<GateDecision> {
  const start = Date.now();

  // Tier 0: Briefing pre-warm skip — if session briefing was already injected, skip Tier 3
  if (process.env.BRIEFING_INJECTED === "1") {
    delete process.env.BRIEFING_INJECTED; // consume the flag (one-shot)
    return { inject: false, method: "briefing_skip", latency_ms: Date.now() - start };
  }

  // Tier 1: Wikilink fast-path (<1ms)
  const wikilinks = extractWikilinks(taskText);
  if (wikilinks.length > 0) {
    return { inject: true, method: "wikilink_fast_path", latency_ms: Date.now() - start };
  }

  // Tier 2: Keyword heuristic (<5ms)
  const hasMemoryKeyword = KEYWORD_MEMORY_PATTERNS.some(p => p.test(taskText));
  const hasSkipKeyword = KEYWORD_SKIP_PATTERNS.some(p => p.test(taskText));
  if (hasSkipKeyword && !hasMemoryKeyword) {
    return { inject: false, method: "keyword_heuristic", latency_ms: Date.now() - start };
  }
  if (hasMemoryKeyword) {
    return { inject: true, method: "keyword_heuristic", latency_ms: Date.now() - start };
  }

  // Tier 3: configured LLM classifier (200ms timeout)
  try {
    const gate = await Promise.race([
      classifyMemoryNeed(taskText),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("gate_timeout")), 200)
      ),
    ]);
    return {
      inject: gate.needs_memory,
      method: "llm_classifier",
      latency_ms: Date.now() - start,
    };
  } catch {
    // Tier 4: Timeout or error — default to inject (safe fallback)
    return { inject: true, method: "timeout_default", latency_ms: Date.now() - start };
  }
}

// --- Sentinel-based once-per-session briefing ---

const BRIEFING_SENTINEL_DIR = "/dev/shm";
const BRIEFING_SENTINEL_TTL_MS = 10 * 60 * 1000; // 10 minutes = same conversation

function getBriefingSentinelPath(persona: string): string {
  return `${BRIEFING_SENTINEL_DIR}/zo-briefing-${persona}.flag`;
}

function isBriefingFresh(persona: string): boolean {
  try {
    const { statSync } = require("fs");
    const stat = statSync(getBriefingSentinelPath(persona));
    return Date.now() - stat.mtimeMs < BRIEFING_SENTINEL_TTL_MS;
  } catch {
    return false;
  }
}

function markBriefingSentinel(persona: string): void {
  try {
    const { writeFileSync } = require("fs");
    writeFileSync(getBriefingSentinelPath(persona), String(Date.now()));
  } catch { /* /dev/shm write failed — non-fatal */ }
}

// --- CLI entry point (backward compatible) ---

function exitWithLog(opts: { code: number; method: string; memoryFound: boolean; persona?: string; latencyMs?: number; startMs?: number }) {
  logGateDecision({
    exitCode: opts.code,
    method: opts.method,
    memoryFound: opts.memoryFound,
    persona: opts.persona ?? undefined,
    latencyMs: opts.latencyMs ?? (opts.startMs ? Date.now() - opts.startMs : undefined),
  });
  process.exit(opts.code);
}

async function main() {
  // Parse --persona flag if present
  const args = process.argv.slice(2);
  let personaSlug: string | null = null;
  const filteredArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--persona" && args[i + 1]) {
      personaSlug = args[i + 1];
      i++; // skip value
    } else if (args[i] === "--briefing" && args[i + 1]) {
      // Standalone briefing mode
      const briefing = await injectSessionBriefing(args[i + 1]);
      if (briefing) {
        console.log(briefing);
        process.exit(0);
      } else {
        console.error("No briefing generated (excluded persona or no data)");
        process.exit(2);
      }
    } else {
      filteredArgs.push(args[i]);
    }
  }

  const message = filteredArgs.join(" ").trim();

  if (!message) {
    console.error("Usage: bun memory-gate.ts <user message>\n       bun memory-gate.ts --persona <slug> <user message>\n       bun memory-gate.ts --briefing <persona-slug>");
    process.exit(1);
  }

  try {
    const gateStart = Date.now();

    // Tier 0a: Auto-inject briefing on first call for this persona (sentinel-based)
    if (personaSlug && !isBriefingFresh(personaSlug)) {
      const briefing = await injectSessionBriefing(personaSlug);
      if (briefing) {
        markBriefingSentinel(personaSlug);
        console.log(briefing);
        console.log(""); // blank line separator before normal gate output
      }
    }

    // Tier 0b: Briefing pre-warm skip (env-based, for module API callers)
    if (process.env.BRIEFING_INJECTED === "1") {
      delete process.env.BRIEFING_INJECTED;
      console.log(JSON.stringify({ inject: false, method: "briefing_skip", latency_ms: 0 }));
      exitWithLog({ code: 2, method: "briefing_skip", memoryFound: false, persona: personaSlug ?? undefined, startMs: gateStart });
    }

    const continuation = detectContinuation(message);

    if (continuation.needsMemory) {
      const continuationResults = await searchContinuation(message);
      if (continuationResults && !continuationResults.includes("No continuation context found")) {
        console.log(continuationResults);
        exitWithLog({ code: 0, method: "continuation", memoryFound: true, persona: personaSlug ?? undefined, startMs: gateStart });
      }
    }

    // Wikilink fast-path: if message contains [[entity]], search directly without an LLM call
    const wikilinks = extractWikilinks(message);
    if (wikilinks.length > 0) {
      const wlKeywords = wikilinks.map(wl => wl.entity);
      const results = await searchMemory(wlKeywords, true);
      if (results && !results.includes("No results") && !results.includes("Found 0 results") && results.length >= 10) {
        console.log(`[Memory Context — wikilink fast-path: ${wlKeywords.join(", ")}]`);
        console.log(results);
        exitWithLog({ code: 0, method: "wikilink_fast_path", memoryFound: true, persona: personaSlug ?? undefined, startMs: gateStart });
      }
    }

    // Keyword heuristic: deterministic pre-check before the classifier
    const hasMemoryKw = KEYWORD_MEMORY_PATTERNS.some(p => p.test(message));
    const hasSkipKw = KEYWORD_SKIP_PATTERNS.some(p => p.test(message));

    if (hasSkipKw && !hasMemoryKw) {
      exitWithLog({ code: 2, method: "keyword_heuristic", memoryFound: false, persona: personaSlug ?? undefined, startMs: gateStart });
    }

    if (hasMemoryKw) {
      const keywords = extractKeywordsFromMessage(message);
      if (keywords.length > 0) {
        const results = await searchMemory(keywords, continuation.needsMemory);
        if (results && !results.includes("No results") && !results.includes("Found 0 results") && results.length >= 10) {
          console.log(`[Memory Context — keywords: ${keywords.join(", ")}]`);
          console.log(results);
          exitWithLog({ code: 0, method: "keyword_heuristic", memoryFound: true, persona: personaSlug ?? undefined, startMs: gateStart });
        }
        exitWithLog({ code: 3, method: "keyword_heuristic", memoryFound: false, persona: personaSlug ?? undefined, startMs: gateStart });
      }
    }

    // Configured LLM classifier (fallback for ambiguous cases)
    const gate = await classifyMemoryNeed(message);

    if (!gate.needs_memory) {
      // No memory needed — exit silently
      exitWithLog({ code: 2, method: "llm_classifier", memoryFound: false, persona: personaSlug ?? undefined, startMs: gateStart });
    }

    if (gate.keywords.length === 0) {
      console.error("Gate said memory needed but extracted no keywords");
      exitWithLog({ code: 3, method: "llm_classifier", memoryFound: false, persona: personaSlug ?? undefined, startMs: gateStart });
    }

    const results = await searchMemory(gate.keywords, continuation.needsMemory);

    if (!results || results.includes("No results") || results.includes("Found 0 results") || results.length < 10) {
      exitWithLog({ code: 3, method: "llm_classifier", memoryFound: false, persona: personaSlug ?? undefined, startMs: gateStart });
    }

    // Output results for injection into context
    console.log(`[Memory Context — keywords: ${gate.keywords.join(", ")}]`);
    console.log(results);

    // --- Inline fact extraction (fires after memory injection) ---
    // Extract conversation context from conversation transcript for fact extraction
    // First, try to get recent conversation messages from the workspace transcript
    const INLINE_CAPTURE_SCRIPT = "/home/workspace/Skills/zo-memory-system/scripts/inline-capture.ts";
    const WORKSPACES_DIR = "/home/.z/workspaces";

    // Try to find the most recent workspace with conversation context
    let conversationContext = "";
    try {
      const { readdirSync, readFileSync, statSync } = await import("fs");
      const { join } = await import("path");
      const conDirs = readdirSync(WORKSPACES_DIR).filter(d => d.startsWith("con_"));
      // Find the most recently active conversation
      let latestMtime = 0;
      let latestDir = "";
      for (const dir of conDirs) {
        try {
          const mtime = statSync(join(WORKSPACES_DIR, dir)).mtimeMs;
          if (mtime > latestMtime) { latestMtime = mtime; latestDir = dir; }
        } catch { /* skip inaccessible dirs */ }
      }
      // Read any transcript or message files in the latest conversation dir
      if (latestDir) {
        const recentFiles = readdirSync(join(WORKSPACES_DIR, latestDir)).filter(f =>
          f.endsWith(".json") || f.endsWith(".md") || f.endsWith(".txt")
        );
        for (const f of recentFiles) {
          try {
            const content = readFileSync(join(WORKSPACES_DIR, latestDir, f), "utf-8").slice(0, 8000);
            if (content.length > 200) { conversationContext = content; break; }
          } catch { /* skip */ }
        }
      }
    } catch { /* workspace read failed — skip context, use message only */ }

    // Spawn inline-capture detached (survives parent exit)
    const captureSource = `inline:chat/${gate.keywords.join("-")}`;
    const capturePersona = personaSlug || "shared";
    const baseArgs = ["bun", INLINE_CAPTURE_SCRIPT, "--message", message, "--persona", capturePersona, "--source", captureSource];
    const captureArgs = conversationContext
      ? [...baseArgs, "--context", conversationContext]
      : baseArgs;

    const proc = Bun.spawn(captureArgs, {
      stdout: "inherit",
      stderr: "inherit",
    });
    // Detach so subprocess outlives parent gate process
    proc.unref();

    exitWithLog({ code: 0, method: "llm_classifier", memoryFound: true, persona: personaSlug ?? undefined, startMs: gateStart });

  } catch (err) {
    console.error(`memory-gate error: ${err}`);
    process.exit(1);
  }
}

// Only run CLI when invoked directly (not imported as module)
if (import.meta.main) {
  main();
}
