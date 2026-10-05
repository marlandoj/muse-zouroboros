#!/usr/bin/env bun
/**
 * Swarm Memory Module v3.0.0
 * Persistent context storage for swarm orchestration
 * 
 * Features:
 * - SQLite-backed persistent storage
 * - Cross-session context sharing
 * - Versioned context with automatic cleanup
 * - Session-to-swarm mapping for resumable operations
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { getMemoryDbPath } from "zouroboros-core";

// ============================================================================
// TYPES
// ============================================================================

export interface SwarmContext {
  id: string;
  swarmId: string;
  content: string;
  metadata: ContextMetadata;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface ContextMetadata {
  sourceAgent?: string;
  tags?: string[];
  priority?: "critical" | "high" | "medium" | "low";
  category?: string;
  relatedSwarmIds?: string[];
}

export interface SwarmSession {
  swarmId: string;
  sessionId: string;
  status: "active" | "completed" | "failed" | "paused";
  createdAt: string;
  updatedAt: string;
  taskCount: number;
  completedCount: number;
  metadata: SessionMetadata;
}

export interface SessionMetadata {
  description?: string;
  initiator?: string;
  tags?: string[];
  parentSwarmId?: string;
}

export interface MemoryQuery {
  swarmId?: string;
  tags?: string[];
  category?: string;
  since?: Date;
  until?: Date;
  limit?: number;
  priority?: string;
}

export type ContextAccessMode = "read" | "write" | "append" | "none";

// ============================================================================
// DATABASE SETUP
// ============================================================================

const DEFAULT_DB_PATH = join(process.env.HOME || "/tmp", ".swarm", "swarm-memory.db");

function ensureDbDirectory(dbPath: string): void {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function initializeDatabase(db: Database): void {
  // Context storage table
  db.exec(`
    CREATE TABLE IF NOT EXISTS swarm_contexts (
      id TEXT PRIMARY KEY,
      swarm_id TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER DEFAULT 1
    )
  `);

  // Session tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS swarm_sessions (
      swarm_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      task_count INTEGER DEFAULT 0,
      completed_count INTEGER DEFAULT 0,
      metadata TEXT
    )
  `);

  // Session-to-context mapping for efficient lookups
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_contexts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      swarm_id TEXT NOT NULL,
      context_id TEXT NOT NULL,
      added_at TEXT NOT NULL,
      UNIQUE(swarm_id, context_id)
    )
  `);

  // Inter-agent messaging table
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      swarm_id TEXT NOT NULL,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      message TEXT NOT NULL,
      message_type TEXT DEFAULT 'info',
      read INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);

  // Create indexes for performance
  db.exec(`CREATE INDEX IF NOT EXISTS idx_contexts_swarm ON swarm_contexts(swarm_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_contexts_created ON swarm_contexts(created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_status ON swarm_sessions(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_contexts_swarm ON session_contexts(swarm_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_to ON agent_messages(to_agent, read)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_swarm ON agent_messages(swarm_id)`);
}

// ============================================================================
// SWARM MEMORY CLASS
// ============================================================================

export class SwarmMemory {
  private db: Database;
  private dbPath: string;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    this.dbPath = dbPath;
    ensureDbDirectory(dbPath);
    this.db = new Database(dbPath);
    initializeDatabase(this.db);
  }

  // --------------------------------------------------------------------------
  // CONTEXT OPERATIONS
  // --------------------------------------------------------------------------

  /**
   * Write new context to swarm memory
   */
  writeContext(
    swarmId: string,
    content: string,
    metadata: ContextMetadata = {}
  ): SwarmContext {
    const id = `${swarmId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date().toISOString();

    const context: SwarmContext = {
      id,
      swarmId,
      content,
      metadata,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };

    const stmt = this.db.prepare(`
      INSERT INTO swarm_contexts (id, swarm_id, content, metadata, created_at, updated_at, version)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      swarmId,
      content,
      JSON.stringify(metadata),
      now,
      now,
      1
    );

    // Link to session
    this.linkContextToSession(swarmId, id);

    return context;
  }

  /**
   * Append content to existing context (creates new version)
   */
  appendContext(
    contextId: string,
    additionalContent: string,
    metadataUpdates: Partial<ContextMetadata> = {}
  ): SwarmContext | null {
    const existing = this.getContext(contextId);
    if (!existing) return null;

    const updatedContent = existing.content + "\n\n" + additionalContent;
    const updatedMetadata = { ...existing.metadata, ...metadataUpdates };
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      UPDATE swarm_contexts 
      SET content = ?, metadata = ?, updated_at = ?, version = version + 1
      WHERE id = ?
    `);

    stmt.run(updatedContent, JSON.stringify(updatedMetadata), now, contextId);

    return this.getContext(contextId);
  }

  /**
   * Read a specific context by ID
   */
  getContext(contextId: string): SwarmContext | null {
    const stmt = this.db.prepare(`
      SELECT * FROM swarm_contexts WHERE id = ?
    `);

    const row = stmt.get(contextId) as any;
    if (!row) return null;

    return this.rowToContext(row);
  }

  /**
   * Query contexts with filters
   */
  queryContexts(query: MemoryQuery = {}): SwarmContext[] {
    let sql = `SELECT * FROM swarm_contexts WHERE 1=1`;
    const params: any[] = [];

    if (query.swarmId) {
      sql += ` AND swarm_id = ?`;
      params.push(query.swarmId);
    }

    if (query.category) {
      sql += ` AND json_extract(metadata, '$.category') = ?`;
      params.push(query.category);
    }

    if (query.priority) {
      sql += ` AND json_extract(metadata, '$.priority') = ?`;
      params.push(query.priority);
    }

    if (query.since) {
      sql += ` AND created_at >= ?`;
      params.push(query.since.toISOString());
    }

    if (query.until) {
      sql += ` AND created_at <= ?`;
      params.push(query.until.toISOString());
    }

    sql += ` ORDER BY created_at DESC`;

    if (query.limit) {
      sql += ` LIMIT ?`;
      params.push(query.limit);
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];

    // Filter by tags in memory (SQLite JSON extraction for arrays is limited)
    let contexts = rows.map(row => this.rowToContext(row));

    if (query.tags && query.tags.length > 0) {
      contexts = contexts.filter(ctx => {
        const ctxTags = ctx.metadata.tags || [];
        return query.tags!.some(tag => ctxTags.includes(tag));
      });
    }

    return contexts;
  }

  /**
   * Get all contexts for a swarm
   */
  getSwarmContexts(swarmId: string): SwarmContext[] {
    return this.queryContexts({ swarmId });
  }

  /**
   * Delete old contexts (cleanup)
   */
  cleanupOldContexts(maxAgeDays: number = 30): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);

    const stmt = this.db.prepare(`
      DELETE FROM swarm_contexts WHERE created_at < ?
    `);

    const result = stmt.run(cutoff.toISOString());
    return result.changes;
  }

  // --------------------------------------------------------------------------
  // SESSION OPERATIONS
  // --------------------------------------------------------------------------

  /**
   * Create or update a swarm session
   */
  createSession(
    swarmId: string,
    sessionId: string,
    metadata: SessionMetadata = {},
    taskCount: number = 0
  ): SwarmSession {
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO swarm_sessions (swarm_id, session_id, status, created_at, updated_at, task_count, completed_count, metadata)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(swarm_id) DO UPDATE SET
        session_id = excluded.session_id,
        status = excluded.status,
        updated_at = excluded.updated_at,
        task_count = excluded.task_count,
        metadata = excluded.metadata
    `);

    stmt.run(
      swarmId,
      sessionId,
      "active",
      now,
      now,
      taskCount,
      JSON.stringify(metadata)
    );

    return this.getSession(swarmId)!;
  }

  /**
   * Get session by swarm ID
   */
  getSession(swarmId: string): SwarmSession | null {
    const stmt = this.db.prepare(`SELECT * FROM swarm_sessions WHERE swarm_id = ?`);
    const row = stmt.get(swarmId) as any;
    if (!row) return null;
    return this.rowToSession(row);
  }

  /**
   * Update session status
   */
  updateSessionStatus(
    swarmId: string,
    status: SwarmSession["status"],
    completedCount?: number
  ): void {
    const updates: string[] = ["status = ?", "updated_at = ?"];
    const params: any[] = [status, new Date().toISOString()];

    if (completedCount !== undefined) {
      updates.push("completed_count = ?");
      params.push(completedCount);
    }

    params.push(swarmId);

    const stmt = this.db.prepare(`
      UPDATE swarm_sessions SET ${updates.join(", ")} WHERE swarm_id = ?
    `);

    stmt.run(...params);
  }

  /**
   * List active sessions
   */
  listActiveSessions(): SwarmSession[] {
    const stmt = this.db.prepare(`
      SELECT * FROM swarm_sessions WHERE status = 'active' ORDER BY updated_at DESC
    `);
    const rows = stmt.all() as any[];
    return rows.map(row => this.rowToSession(row));
  }

  /**
   * Find sessions by tags or description
   */
  findSessions(query: string): SwarmSession[] {
    const stmt = this.db.prepare(`
      SELECT * FROM swarm_sessions 
      WHERE swarm_id LIKE ? 
         OR json_extract(metadata, '$.description') LIKE ?
         OR json_extract(metadata, '$.tags') LIKE ?
      ORDER BY updated_at DESC
    `);

    const pattern = `%${query}%`;
    const rows = stmt.all(pattern, pattern, pattern) as any[];
    return rows.map(row => this.rowToSession(row));
  }

  // --------------------------------------------------------------------------
  // HELPER METHODS
  // --------------------------------------------------------------------------

  private linkContextToSession(swarmId: string, contextId: string): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO session_contexts (swarm_id, context_id, added_at)
      VALUES (?, ?, ?)
    `);
    stmt.run(swarmId, contextId, new Date().toISOString());
  }

  private rowToContext(row: any): SwarmContext {
    return {
      id: row.id,
      swarmId: row.swarm_id,
      content: row.content,
      metadata: JSON.parse(row.metadata || "{}"),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version,
    };
  }

  private rowToSession(row: any): SwarmSession {
    return {
      swarmId: row.swarm_id,
      sessionId: row.session_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      taskCount: row.task_count,
      completedCount: row.completed_count,
      metadata: JSON.parse(row.metadata || "{}"),
    };
  }

  // --------------------------------------------------------------------------
  // FORMATTING FOR AGENT INJECTION
  // --------------------------------------------------------------------------

  /**
   * Format context for injection into agent prompts
   */
  formatContextForInjection(contexts: SwarmContext[], mode: ContextAccessMode): string {
    if (mode === "none" || contexts.length === 0) {
      return "";
    }

    const sections = contexts.map(ctx => {
      const meta = ctx.metadata;
      const header = [
        `Source: ${meta.sourceAgent || "unknown"}`,
        meta.category ? `Category: ${meta.category}` : "",
        meta.priority ? `Priority: ${meta.priority}` : "",
        `Recorded: ${new Date(ctx.createdAt).toLocaleString()}`,
      ].filter(Boolean).join(" | ");

      return `---\n${header}\n${ctx.content}\n---`;
    });

    return `
## Previous Swarm Context

The following context has been shared from previous swarm sessions:

${sections.join("\n\n")}

Use this context to inform your analysis, but focus on your specific task.
`;
  }

  /**
   * Get database statistics
   */
  getStats(): { contexts: number; sessions: number; dbPath: string } {
    const contextCount = this.db.prepare("SELECT COUNT(*) as count FROM swarm_contexts").get() as any;
    const sessionCount = this.db.prepare("SELECT COUNT(*) as count FROM swarm_sessions").get() as any;

    return {
      contexts: contextCount.count,
      sessions: sessionCount.count,
      dbPath: this.dbPath,
    };
  }

  // --------------------------------------------------------------------------
  // CROSS-DATABASE QUERY (Persona Memory Bridge)
  // --------------------------------------------------------------------------

  /**
   * Query the persona memory database (shared-facts.db) for relevant context.
   * Bridges swarm orchestration with persona long-term memory.
   */
  queryPersonaMemory(
    query: string,
    options: { persona?: string; limit?: number } = {}
  ): Array<{ entity: string; key: string | null; value: string; category: string; decayClass: string }> {
    const personaDbPath = getMemoryDbPath();
    if (!existsSync(personaDbPath)) return [];

    let personaDb: Database | null = null;
    try {
      personaDb = new Database(personaDbPath, { readonly: true });
      personaDb.exec("PRAGMA busy_timeout = 3000");
      const nowSec = Math.floor(Date.now() / 1000);
      const { persona, limit = 5 } = options;

      // FTS search against persona facts
      const safeQuery = query
        .replace(/['"]/g, "")
        .split(/\s+/)
        .filter((w: string) => w.length > 1)
        .map((w: string) => `"${w}"`)
        .join(" OR ");

      if (!safeQuery) return [];

      const rows = personaDb.prepare(`
        SELECT f.entity, f.key, f.value, f.category, f.decay_class
        FROM facts f
        JOIN facts_fts fts ON f.rowid = fts.rowid
        WHERE facts_fts MATCH ?
          AND (f.expires_at IS NULL OR f.expires_at > ?)
          ${persona ? "AND f.persona = ?" : ""}
        ORDER BY rank
        LIMIT ?
      `).all(...[safeQuery, nowSec, ...(persona ? [persona] : []), limit]) as any[];

      return rows.map((r: any) => ({
        entity: r.entity,
        key: r.key,
        value: r.value,
        category: r.category,
        decayClass: r.decay_class,
      }));
    } catch {
      return [];
    } finally {
      personaDb?.close();
    }
  }

  // --------------------------------------------------------------------------
  // INTER-AGENT MESSAGING
  // --------------------------------------------------------------------------

  /**
   * Send a message from one agent to another within a swarm
   */
  sendMessage(
    swarmId: string,
    fromAgent: string,
    toAgent: string,
    message: string,
    messageType: "info" | "request" | "result" | "error" = "info"
  ): void {
    this.db.prepare(`
      INSERT INTO agent_messages (swarm_id, from_agent, to_agent, message, message_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(swarmId, fromAgent, toAgent, message, messageType, new Date().toISOString());
  }

  /**
   * Read unread messages for an agent
   */
  readMessages(
    toAgent: string,
    options: { swarmId?: string; markRead?: boolean } = {}
  ): Array<{ id: number; fromAgent: string; message: string; messageType: string; createdAt: string }> {
    const { swarmId, markRead = true } = options;

    let sql = `SELECT * FROM agent_messages WHERE to_agent = ? AND read = 0`;
    const params: any[] = [toAgent];

    if (swarmId) {
      sql += ` AND swarm_id = ?`;
      params.push(swarmId);
    }

    sql += ` ORDER BY created_at ASC`;

    const rows = this.db.prepare(sql).all(...params) as any[];

    if (markRead && rows.length > 0) {
      const ids = rows.map((r: any) => r.id);
      this.db.prepare(`UPDATE agent_messages SET read = 1 WHERE id IN (${ids.map(() => "?").join(",")})`)
        .run(...ids);
    }

    return rows.map((r: any) => ({
      id: r.id,
      fromAgent: r.from_agent,
      message: r.message,
      messageType: r.message_type,
      createdAt: r.created_at,
    }));
  }

  /**
   * Get message statistics for a swarm
   */
  getMessageStats(swarmId: string): { total: number; unread: number; byAgent: Record<string, number> } {
    const total = (this.db.prepare("SELECT COUNT(*) as cnt FROM agent_messages WHERE swarm_id = ?").get(swarmId) as any).cnt;
    const unread = (this.db.prepare("SELECT COUNT(*) as cnt FROM agent_messages WHERE swarm_id = ? AND read = 0").get(swarmId) as any).cnt;
    const byAgent = this.db.prepare(`
      SELECT to_agent, COUNT(*) as cnt FROM agent_messages WHERE swarm_id = ? GROUP BY to_agent
    `).all(swarmId) as any[];

    const agentCounts: Record<string, number> = {};
    for (const row of byAgent) {
      agentCounts[row.to_agent] = row.cnt;
    }

    return { total, unread, byAgent: agentCounts };
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let globalMemory: SwarmMemory | null = null;

export function getSwarmMemory(dbPath?: string): SwarmMemory {
  if (!globalMemory) {
    globalMemory = new SwarmMemory(dbPath);
  }
  return globalMemory;
}

export function resetGlobalMemory(): void {
  if (globalMemory) {
    globalMemory.close();
    globalMemory = null;
  }
}

// ============================================================================
// CLI INTERFACE
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  const memory = getSwarmMemory();

  switch (command) {
    case "stats": {
      const stats = memory.getStats();
      console.log("Swarm Memory Statistics:");
      console.log(`  Database: ${stats.dbPath}`);
      console.log(`  Total Contexts: ${stats.contexts}`);
      console.log(`  Total Sessions: ${stats.sessions}`);
      break;
    }

    case "list-sessions": {
      const sessions = memory.listActiveSessions();
      console.log("Active Swarm Sessions:");
      for (const session of sessions) {
        console.log(`\n  ${session.swarmId}`);
        console.log(`    Status: ${session.status}`);
        console.log(`    Tasks: ${session.completedCount}/${session.taskCount}`);
        console.log(`    Updated: ${new Date(session.updatedAt).toLocaleString()}`);
        if (session.metadata.description) {
          console.log(`    Description: ${session.metadata.description}`);
        }
      }
      break;
    }

    case "list-contexts": {
      const swarmId = args[1];
      if (!swarmId) {
        console.error("Usage: bun swarm-memory.ts list-contexts <swarm-id>");
        process.exit(1);
      }
      const contexts = memory.getSwarmContexts(swarmId);
      console.log(`Contexts for swarm "${swarmId}":`);
      for (const ctx of contexts) {
        console.log(`\n  ${ctx.id}`);
        console.log(`    Version: ${ctx.version}`);
        console.log(`    Created: ${new Date(ctx.createdAt).toLocaleString()}`);
        console.log(`    Preview: ${ctx.content.substring(0, 100)}...`);
      }
      break;
    }

    case "cleanup": {
      const days = parseInt(args[1]) || 30;
      const deleted = memory.cleanupOldContexts(days);
      console.log(`Cleaned up ${deleted} contexts older than ${days} days`);
      break;
    }

    default: {
      console.log("Swarm Memory Manager v3.0.0");
      console.log("\nUsage: bun swarm-memory.ts <command>");
      console.log("\nCommands:");
      console.log("  stats              - Show database statistics");
      console.log("  list-sessions      - List active swarm sessions");
      console.log("  list-contexts <id> - List contexts for a swarm");
      console.log("  cleanup [days]     - Remove old contexts (default: 30 days)");
      break;
    }
  }

  memory.close();
}
