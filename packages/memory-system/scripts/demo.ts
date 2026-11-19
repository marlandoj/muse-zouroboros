#!/usr/bin/env bun
/**
 * Demo script for Zo Persona Memory System
 * Run this to see the system in action
 */

const MEMORY_SCRIPT = "/home/workspace/.zo/memory/scripts/memory.ts";

async function run(args: string[]): Promise<string> {
  const proc = Bun.spawn(["bun", MEMORY_SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  
  return stdout || stderr;
}

async function main() {
  console.log("═".repeat(60));
  console.log("Zo Persona Memory System Demo");
  console.log("═".repeat(60));
  console.log();
  
  // 1. Store some facts
  console.log("📦 Storing facts with different decay classes...\n");
  
  const facts = [
    { entity: "user", key: "name", value: "Alice Smith", decay: "permanent", category: "fact" },
    { entity: "user", key: "birthday", value: "June 3rd", decay: "permanent", category: "fact" },
    { entity: "user", key: "risk_tolerance", value: "Conservative", decay: "stable", category: "preference" },
    { entity: "project", key: "current_task", value: "Implement memory system", decay: "active", category: "fact" },
    { entity: "decision", key: "database", value: "SQLite over LanceDB for structured queries", decay: "permanent", category: "decision" },
  ];
  
  for (const fact of facts) {
    const args = [
      "store",
      "--entity", fact.entity,
      "--key", fact.key,
      "--value", fact.value,
      "--decay", fact.decay,
      "--category", fact.category,
    ];
    const result = await run(args);
    console.log(`  ✓ ${fact.entity}.${fact.key} (${fact.decay})`);
  }
  
  console.log();
  console.log("─".repeat(60));
  console.log();
  
  // 2. Search
  console.log("🔍 Searching for 'birthday'...\n");
  const searchResult = await run(["search", "birthday", "--limit", "3"]);
  console.log(searchResult);
  
  console.log("─".repeat(60));
  console.log();
  
  // 3. Lookup
  console.log("📋 Looking up user preferences...\n");
  const lookupResult = await run(["lookup", "--entity", "user"]);
  console.log(lookupResult);
  
  console.log("─".repeat(60));
  console.log();
  
  // 4. Stats
  console.log("📊 Memory statistics:\n");
  const statsResult = await run(["stats"]);
  console.log(statsResult);
  
  console.log("─".repeat(60));
  console.log();
  
  // 5. Checkpoint
  console.log("💾 Saving checkpoint...\n");
  const checkpointResult = await run([
    "checkpoint", "save",
    "--intent", "Demo memory system",
    "--state", "All demos running successfully",
    "--expected", "User understands the system",
  ]);
  console.log(checkpointResult);
  
  console.log();
  console.log("═".repeat(60));
  console.log("Demo complete!");
  console.log("═".repeat(60));
  console.log();
  console.log("Next steps:");
  console.log("  1. Read the README: file '.zo/memory/README.md'");
  console.log("  2. Check integration options: file '.zo/memory/INTEGRATION.md'");
  console.log("  3. Set up scheduled maintenance (see README)");
  console.log();
  console.log("Clean up demo data:");
  console.log("  bun .zo/memory/scripts/memory.ts prune");
}

main().catch(console.error);
