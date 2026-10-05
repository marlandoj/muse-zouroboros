#!/usr/bin/env bun
/**
 * procedure-git.ts — Git-Commit Procedure Evolution
 *
 * Stores versioned workflow patterns as markdown files in a git-tracked vault,
 * providing a full audit trail of how procedures changed and why.
 *
 * Each procedure version is a commit in a git repository. Evolved procedures
 * create new commits with parent references, enabling full history browsing
 * via standard git tools.
 *
 * Integration points:
 * - Zouroboros procedural memory (SQLite tables)
 * - Git repository for audit trail
 * - Ori-style vault structure (markdown on disk)
 */

import { Database } from "bun:sqlite";
import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";

// Configuration
const DEFAULT_CONFIG = {
  vaultDir: "/home/workspace/.zo/memory/procedures",
  gitUserName: "Zo Memory System",
  gitUserEmail: "memory@zo.computer",
};

export interface GitProcedureConfig {
  vaultDir: string;
  gitUserName: string;
  gitUserEmail: string;
}

export interface ProcedureVersion {
  id: string;
  name: string;
  version: number;
  steps: ProcedureStep[];
  successCount: number;
  failureCount: number;
  createdAt: number;
  evolvedFrom?: string;
  evolutionRationale?: string;
  gitCommit?: string;
  filePath?: string;
}

export interface ProcedureStep {
  executor: string;
  taskPattern: string;
  timeoutSeconds: number;
  fallbackExecutor?: string;
}

export interface GitLogEntry {
  commit: string;
  date: string;
  message: string;
  procedureName: string;
  version: number;
  author: string;
  stats: { additions: number; deletions: number };
}

/**
 * Initialize git repository for procedures
 */
export function initProcedureGit(config: GitProcedureConfig = DEFAULT_CONFIG): void {
  if (!existsSync(config.vaultDir)) {
    mkdirSync(config.vaultDir, { recursive: true });
  }
  
  const gitDir = join(config.vaultDir, ".git");
  if (!existsSync(gitDir)) {
    execSync("git init", { cwd: config.vaultDir });
    execSync(`git config user.name "${config.gitUserName}"`, { cwd: config.vaultDir });
    execSync(`git config user.email "${config.gitUserEmail}"`, { cwd: config.vaultDir });
    
    // Create initial README
    const readmePath = join(config.vaultDir, "README.md");
    writeFileSync(readmePath, `# Procedure Vault

Git-tracked workflow procedures for the Zouroboros memory system.

Each procedure is stored as a markdown file with full version history.
Generated: ${new Date().toISOString()}
`);
    
    execSync("git add README.md", { cwd: config.vaultDir });
    execSync('git commit -m "Initial commit: Procedure vault"', { cwd: config.vaultDir });
  }
}

/**
 * Serialize procedure to markdown
 */
function procedureToMarkdown(proc: ProcedureVersion): string {
  const lines: string[] = [
    `---`,
    `id: ${proc.id}`,
    `name: ${proc.name}`,
    `version: ${proc.version}`,
    `created_at: ${new Date(proc.createdAt * 1000).toISOString()}`,
    `success_count: ${proc.successCount}`,
    `failure_count: ${proc.failureCount}`,
  ];
  
  if (proc.evolvedFrom) {
    lines.push(`evolved_from: ${proc.evolvedFrom}`);
  }
  
  lines.push(`---\n`);
  lines.push(`# ${proc.name} (v${proc.version})\n`);
  
  if (proc.evolutionRationale) {
    lines.push(`## Evolution Rationale\n`);
    lines.push(`${proc.evolutionRationale}\n`);
  }
  
  lines.push(`## Steps\n`);
  
  for (let i = 0; i < proc.steps.length; i++) {
    const step = proc.steps[i];
    lines.push(`${i + 1}. **${step.executor}**: ${step.taskPattern}`);
    lines.push(`   - Timeout: ${step.timeoutSeconds}s`);
    if (step.fallbackExecutor) {
      lines.push(`   - Fallback: ${step.fallbackExecutor}`);
    }
    lines.push("");
  }
  
  lines.push(`\n## Performance\n`);
  lines.push(`- Successes: ${proc.successCount}`);
  lines.push(`- Failures: ${proc.failureCount}`);
  const total = proc.successCount + proc.failureCount;
  if (total > 0) {
    lines.push(`- Success rate: ${((proc.successCount / total) * 100).toFixed(1)}%`);
  }
  
  lines.push("");
  return lines.join("\n");
}

/**
 * Parse markdown to procedure (basic implementation)
 */
function markdownToProcedure(content: string, filePath: string): Partial<ProcedureVersion> {
  const lines = content.split("\n");
  const frontmatter: Record<string, string> = {};
  let inFrontmatter = false;
  let frontmatterEnd = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "---") {
      if (!inFrontmatter) {
        inFrontmatter = true;
      } else {
        frontmatterEnd = i;
        break;
      }
      continue;
    }
    
    if (inFrontmatter) {
      const match = line.match(/^([a-z_]+):\s*(.+)$/);
      if (match) {
        frontmatter[match[1]] = match[2];
      }
    }
  }
  
  return {
    id: frontmatter.id || "",
    name: frontmatter.name || "",
    version: parseInt(frontmatter.version) || 1,
    successCount: parseInt(frontmatter.success_count) || 0,
    failureCount: parseInt(frontmatter.failure_count) || 0,
    createdAt: frontmatter.created_at ? Math.floor(new Date(frontmatter.created_at).getTime() / 1000) : Date.now() / 1000,
    evolvedFrom: frontmatter.evolved_from,
  };
}

/**
 * Save procedure to vault and commit to git
 */
export function saveProcedureToGit(
  proc: ProcedureVersion,
  config: GitProcedureConfig = DEFAULT_CONFIG
): { filePath: string; commitHash: string } {
  initProcedureGit(config);
  
  const fileName = `${proc.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-v${proc.version}.md`;
  const filePath = join(config.vaultDir, fileName);
  
  const content = procedureToMarkdown(proc);
  writeFileSync(filePath, content);
  
  // Git operations
  execSync(`git add "${fileName}"`, { cwd: config.vaultDir });
  
  const commitMessage = proc.evolvedFrom
    ? `Evolve ${proc.name}: v${proc.version - 1} -> v${proc.version}\n\n${proc.evolutionRationale || "Automated evolution based on failure analysis"}`
    : `Create ${proc.name}: v${proc.version}`;
  
  try {
    execSync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, { cwd: config.vaultDir });
  } catch (e) {
    // Commit might fail if nothing changed, that's okay
  }
  
  // Get commit hash
  const commitHash = execSync("git rev-parse HEAD", { cwd: config.vaultDir, encoding: "utf-8" }).trim();
  
  return { filePath, commitHash };
}

/**
 * Get git log for a procedure
 */
export function getProcedureGitLog(
  procedureName: string,
  config: GitProcedureConfig = DEFAULT_CONFIG
): GitLogEntry[] {
  if (!existsSync(config.vaultDir)) return [];
  
  try {
    const pattern = `${procedureName.replace(/[^a-z0-9]+/gi, "-")}-v*.md`;
    const logOutput = execSync(
      `git log --follow --format="%H|%ci|%s|%an" -- "${pattern}"`,
      { cwd: config.vaultDir, encoding: "utf-8" }
    );
    
    const entries: GitLogEntry[] = [];
    const lines = logOutput.trim().split("\n").filter(l => l);
    
    for (const line of lines) {
      const parts = line.split("|");
      if (parts.length >= 4) {
        const [commit, date, message, author] = parts;
        
        // Get stats
        let stats = { additions: 0, deletions: 0 };
        try {
          const statOutput = execSync(
            `git show --stat --format="" ${commit}`,
            { cwd: config.vaultDir, encoding: "utf-8" }
          );
          const match = statOutput.match(/(\d+) insertion.*?\(\+\).*?(\d+) deletion.*?\(-\)/);
          if (match) {
            stats = { additions: parseInt(match[1]), deletions: parseInt(match[2]) };
          }
        } catch (e) {
          // Ignore stat errors
        }
        
        // Parse version from message
        const versionMatch = message.match(/v(\d+)/);
        const version = versionMatch ? parseInt(versionMatch[1]) : 1;
        
        entries.push({
          commit,
          date,
          message,
          procedureName,
          version,
          author,
          stats,
        });
      }
    }
    
    return entries;
  } catch (e) {
    return [];
  }
}

/**
 * Sync procedures from database to git vault
 */
export function syncProceduresToGit(
  db: Database,
  config: GitProcedureConfig = DEFAULT_CONFIG
): { synced: number; errors: string[] } {
  initProcedureGit(config);
  
  const procedures = db.prepare(`
    SELECT id, name, version, steps, success_count, failure_count, 
           created_at, evolved_from, evolution_rationale
    FROM procedures
    ORDER BY name, version
  `).all() as Array<{
    id: string;
    name: string;
    version: number;
    steps: string;
    success_count: number;
    failure_count: number;
    created_at: number;
    evolved_from: string | null;
    evolution_rationale: string | null;
  }>;
  
  const errors: string[] = [];
  let synced = 0;
  
  for (const proc of procedures) {
    try {
      const version: ProcedureVersion = {
        id: proc.id,
        name: proc.name,
        version: proc.version,
        steps: JSON.parse(proc.steps),
        successCount: proc.success_count,
        failureCount: proc.failure_count,
        createdAt: proc.created_at,
        evolvedFrom: proc.evolved_from || undefined,
        evolutionRationale: proc.evolution_rationale || undefined,
      };
      
      const result = saveProcedureToGit(version, config);
      synced++;
    } catch (e) {
      errors.push(`${proc.name} v${proc.version}: ${e}`);
    }
  }
  
  return { synced, errors };
}

/**
 * Compare two procedure versions
 */
export function compareProcedureVersions(
  procedureName: string,
  versionA: number,
  versionB: number,
  config: GitProcedureConfig = DEFAULT_CONFIG
): { diff: string; summary: string } {
  const filePattern = procedureName.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  
  try {
    // Find commits for each version
    const logA = execSync(
      `git log --all --oneline -- "${filePattern}-v${versionA}.md" | head -1`,
      { cwd: config.vaultDir, encoding: "utf-8" }
    ).trim();
    
    const logB = execSync(
      `git log --all --oneline -- "${filePattern}-v${versionB}.md" | head -1`,
      { cwd: config.vaultDir, encoding: "utf-8" }
    ).trim();
    
    const commitA = logA.split(" ")[0];
    const commitB = logB.split(" ")[0];
    
    if (!commitA || !commitB) {
      return { diff: "", summary: "Could not find commits for both versions" };
    }
    
    const diff = execSync(
      `git diff ${commitA} ${commitB} -- "${filePattern}-v*.md"`,
      { cwd: config.vaultDir, encoding: "utf-8" }
    );
    
    // Generate summary
    const added = (diff.match(/^\+[^+]/gm) || []).length;
    const removed = (diff.match(/^-[^-]/gm) || []).length;
    
    return {
      diff,
      summary: `${added} lines added, ${removed} lines removed between v${versionA} and v${versionB}`,
    };
  } catch (e) {
    return { diff: "", summary: `Error: ${e}` };
  }
}

/**
 * Get all procedures with their git history
 */
export function getAllProceduresWithHistory(
  config: GitProcedureConfig = DEFAULT_CONFIG
): Array<{ name: string; versions: number; latestCommit: string; history: GitLogEntry[] }> {
  if (!existsSync(config.vaultDir)) return [];
  
  try {
    // Find all procedure files
    const files = readdirSync(config.vaultDir).filter(f => f.match(/-v\d+\.md$/));
    const procedures = new Map<string, { versions: number; latestCommit: string }>();
    
    for (const file of files) {
      const match = file.match(/^(.+)-v(\d+)\.md$/);
      if (match) {
        const name = match[1];
        const version = parseInt(match[2]);
        
        const existing = procedures.get(name);
        if (!existing || version > existing.versions) {
          // Get latest commit for this file
          try {
            const commit = execSync(
              `git log -1 --format="%H" -- "${file}"`,
              { cwd: config.vaultDir, encoding: "utf-8" }
            ).trim();
            procedures.set(name, { versions: version, latestCommit: commit });
          } catch (e) {
            procedures.set(name, { versions: version, latestCommit: "unknown" });
          }
        }
      }
    }
    
    // Build result with full history
    return Array.from(procedures.entries()).map(([name, info]) => ({
      name,
      versions: info.versions,
      latestCommit: info.latestCommit,
      history: getProcedureGitLog(name, config),
    }));
  } catch (e) {
    return [];
  }
}

/**
 * CLI for procedure-git operations
 */
function printUsage() {
  console.log(`
zo-memory-system procedure-git — Git-Tracked Procedure Evolution

Usage:
  bun procedure-git.ts <command> [options]

Commands:
  init               Initialize procedure git vault
  sync               Sync all procedures from database to git
  log                Show git log for a procedure
  diff               Compare two procedure versions
  list               List all procedures with version history

Options:
  --procedure <name> Procedure name (for log/diff commands)
  --version-a <n>    First version (for diff)
  --version-b <n>    Second version (for diff)
  --vault <path>     Path to procedure vault (default: ~/.zo/memory/procedures)

Examples:
  bun procedure-git.ts init
  bun procedure-git.ts sync
  bun procedure-git.ts log --procedure "site-review"
  bun procedure-git.ts diff --procedure "site-review" --version-a 1 --version-b 2
  bun procedure-git.ts list
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "help" || command === "--help") {
    printUsage();
    process.exit(0);
  }

  const flags: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      flags[args[i].slice(2)] = args[i + 1] || "";
      i++;
    }
  }

  const config: GitProcedureConfig = {
    ...DEFAULT_CONFIG,
    vaultDir: flags.vault || DEFAULT_CONFIG.vaultDir,
  };

  const DB_PATH = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";

  switch (command) {
    case "init": {
      initProcedureGit(config);
      console.log(`Initialized procedure vault at: ${config.vaultDir}`);
      
      // Show git status
      try {
        const status = execSync("git status --short", { cwd: config.vaultDir, encoding: "utf-8" });
        if (status.trim()) {
          console.log("\nGit status:");
          console.log(status);
        } else {
          console.log("\nVault is clean.");
        }
      } catch (e) {
        // Ignore
      }
      break;
    }

    case "sync": {
      const db = new Database(DB_PATH);
      console.log("Syncing procedures from database to git...\n");
      
      const result = syncProceduresToGit(db, config);
      console.log(`Synced: ${result.synced} procedures`);
      
      if (result.errors.length > 0) {
        console.log(`\nErrors (${result.errors.length}):`);
        for (const err of result.errors) {
          console.log(`  - ${err}`);
        }
      }
      
      db.close();
      break;
    }

    case "log": {
      if (!flags.procedure) {
        console.error("Error: --procedure is required");
        process.exit(1);
      }
      
      const history = getProcedureGitLog(flags.procedure, config);
      
      if (history.length === 0) {
        console.log(`No git history found for: ${flags.procedure}`);
        break;
      }
      
      console.log(`\nGit history for "${flags.procedure}":\n`);
      for (const entry of history) {
        console.log(`${entry.commit.slice(0, 8)}  ${entry.date.split(" ")[0]}  v${entry.version}`);
        console.log(`  ${entry.message.split("\n")[0]}`);
        if (entry.stats.additions || entry.stats.deletions) {
          console.log(`  +${entry.stats.additions} -${entry.stats.deletions}`);
        }
        console.log();
      }
      break;
    }

    case "diff": {
      if (!flags.procedure || !flags["version-a"] || !flags["version-b"]) {
        console.error("Error: --procedure, --version-a, and --version-b are required");
        process.exit(1);
      }
      
      const result = compareProcedureVersions(
        flags.procedure,
        parseInt(flags["version-a"]),
        parseInt(flags["version-b"]),
        config
      );
      
      console.log(`\n${result.summary}\n`);
      if (result.diff) {
        console.log(result.diff);
      }
      break;
    }

    case "list": {
      const procedures = getAllProceduresWithHistory(config);
      
      if (procedures.length === 0) {
        console.log("No procedures found in vault.");
        break;
      }
      
      console.log(`\n${procedures.length} procedure(s) in vault:\n`);
      
      for (const proc of procedures) {
        console.log(`${proc.name}`);
        console.log(`  Versions: ${proc.versions}`);
        console.log(`  Commits: ${proc.history.length}`);
        if (proc.history.length > 0) {
          const latest = proc.history[0];
          console.log(`  Latest: ${latest.date.split(" ")[0]} - ${latest.message.split("\n")[0]}`);
        }
        console.log();
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

if (import.meta.main) {
  main().catch(console.error);
}
