/**
 * Role Registry — named roles mapped to executor + model + capabilities.
 *
 * Stored in SQLite for dynamic CRUD, queryable, survives restarts.
 * Resolves role→executor before task dispatch.
 */

import { getDb } from '../db/schema.js';
import type { Database } from 'bun:sqlite';

export interface Role {
  id: string;
  name: string;
  executorId: string;
  model?: string | null;
  tags: string[];
  description: string;
  budgetCapUSD?: number | null;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  successCriteria?: string[];
  createdAt?: number;
  updatedAt?: number;
}

export interface RoleResolution {
  executorId: string;
  model?: string;
  roleId: string;
  roleName: string;
}

export type SOPEnforcement = 'soft' | 'hard';

export interface RoleRegistryConfig {
  enforcement?: SOPEnforcement;
}

export class RoleRegistry {
  private db: Database;
  readonly enforcement: SOPEnforcement;

  constructor(dbPath?: string, config: RoleRegistryConfig = {}) {
    this.db = getDb(dbPath);
    this.enforcement = config.enforcement ?? 'soft';
  }

  create(role: Omit<Role, 'createdAt' | 'updatedAt'>): Role {
    const tags = JSON.stringify(role.tags);
    this.db.run(
      `INSERT INTO swarm_roles (id, name, executor_id, model, tags, description, budget_cap_usd, inputs, outputs, success_criteria)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        role.id,
        role.name,
        role.executorId,
        role.model ?? null,
        tags,
        role.description,
        role.budgetCapUSD ?? null,
        role.inputs ? JSON.stringify(role.inputs) : null,
        role.outputs ? JSON.stringify(role.outputs) : null,
        role.successCriteria ? JSON.stringify(role.successCriteria) : null,
      ]
    );
    return this.get(role.id)!;
  }

  get(id: string): Role | null {
    const row = this.db.query(
      'SELECT * FROM swarm_roles WHERE id = ?'
    ).get(id) as RoleRow | null;
    return row ? rowToRole(row) : null;
  }

  list(): Role[] {
    const rows = this.db.query(
      'SELECT * FROM swarm_roles ORDER BY name'
    ).all() as RoleRow[];
    return rows.map(rowToRole);
  }

  update(id: string, updates: Partial<Omit<Role, 'id' | 'createdAt' | 'updatedAt'>>): Role | null {
    const existing = this.get(id);
    if (!existing) return null;

    const name = updates.name ?? existing.name;
    const executorId = updates.executorId ?? existing.executorId;
    const model = updates.model !== undefined ? updates.model : existing.model;
    const tags = updates.tags ? JSON.stringify(updates.tags) : JSON.stringify(existing.tags);
    const description = updates.description ?? existing.description;
    const budgetCap = updates.budgetCapUSD !== undefined ? updates.budgetCapUSD : existing.budgetCapUSD;
    const inputs =
      updates.inputs !== undefined
        ? updates.inputs
          ? JSON.stringify(updates.inputs)
          : null
        : existing.inputs
          ? JSON.stringify(existing.inputs)
          : null;
    const outputs =
      updates.outputs !== undefined
        ? updates.outputs
          ? JSON.stringify(updates.outputs)
          : null
        : existing.outputs
          ? JSON.stringify(existing.outputs)
          : null;
    const successCriteria =
      updates.successCriteria !== undefined
        ? updates.successCriteria
          ? JSON.stringify(updates.successCriteria)
          : null
        : existing.successCriteria
          ? JSON.stringify(existing.successCriteria)
          : null;

    this.db.run(
      `UPDATE swarm_roles SET name=?, executor_id=?, model=?, tags=?, description=?, budget_cap_usd=?, inputs=?, outputs=?, success_criteria=?, updated_at=unixepoch()
       WHERE id=?`,
      [name, executorId, model ?? null, tags, description, budgetCap ?? null, inputs, outputs, successCriteria, id]
    );

    return this.get(id);
  }

  delete(id: string): boolean {
    const result = this.db.run('DELETE FROM swarm_roles WHERE id = ?', [id]);
    return result.changes > 0;
  }

  validateSOPContract(role: Role): { valid: boolean; missing: string[]; error?: string } {
    const missing: string[] = [];
    if (!role.inputs || Object.keys(role.inputs).length === 0) missing.push('inputs');
    if (!role.outputs || Object.keys(role.outputs).length === 0) missing.push('outputs');
    if (!role.successCriteria || role.successCriteria.length === 0) missing.push('successCriteria');
    if (missing.length === 0) return { valid: true, missing: [] };
    return {
      valid: false,
      missing,
      error: `Role "${role.name}" missing SOP contract fields: ${missing.join(', ')}`,
    };
  }

  resolve(roleId: string): RoleResolution | null {
    const role = this.get(roleId);
    if (!role) return null;

    if (this.enforcement === 'hard') {
      const validation = this.validateSOPContract(role);
      if (!validation.valid) {
        throw new Error(
          `[SOP enforcement=hard] ${validation.error}. Dispatch blocked. Populate inputs/outputs/successCriteria to proceed.`
        );
      }
    }

    return {
      executorId: role.executorId,
      model: role.model ?? undefined,
      roleId: role.id,
      roleName: role.name,
    };
  }

  findByTag(tag: string): Role[] {
    const all = this.list();
    return all.filter(r => r.tags.some(t => t.toLowerCase().includes(tag.toLowerCase())));
  }

  bulkCreate(roles: Omit<Role, 'createdAt' | 'updatedAt'>[]): number {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO swarm_roles (id, name, executor_id, model, tags, description, budget_cap_usd, inputs, outputs, success_criteria)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let count = 0;
    for (const role of roles) {
      const result = stmt.run(
        role.id, role.name, role.executorId, role.model ?? null,
        JSON.stringify(role.tags), role.description, role.budgetCapUSD ?? null,
        role.inputs ? JSON.stringify(role.inputs) : null,
        role.outputs ? JSON.stringify(role.outputs) : null,
        role.successCriteria ? JSON.stringify(role.successCriteria) : null,
      );
      if (result.changes > 0) count++;
    }
    return count;
  }

  countWithSOP(): number {
    return (
      this.db
        .query(
          `SELECT COUNT(*) as cnt FROM swarm_roles WHERE inputs IS NOT NULL AND outputs IS NOT NULL AND success_criteria IS NOT NULL`
        )
        .get() as { cnt: number }
    ).cnt;
  }

  count(): number {
    return (this.db.query('SELECT COUNT(*) as cnt FROM swarm_roles').get() as { cnt: number }).cnt;
  }
}

interface RoleRow {
  id: string;
  name: string;
  executor_id: string;
  model: string | null;
  tags: string;
  description: string;
  budget_cap_usd: number | null;
  inputs: string | null;
  outputs: string | null;
  success_criteria: string | null;
  created_at: number;
  updated_at: number;
}

function parseJsonField<T>(raw: string | null): T | undefined {
  if (raw === null || raw === '') return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function rowToRole(row: RoleRow): Role {
  let tags: string[] = [];
  try { tags = JSON.parse(row.tags); } catch {}
  const role: Role = {
    id: row.id,
    name: row.name,
    executorId: row.executor_id,
    model: row.model,
    tags,
    description: row.description,
    budgetCapUSD: row.budget_cap_usd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  const inputs = parseJsonField<Record<string, unknown>>(row.inputs);
  const outputs = parseJsonField<Record<string, unknown>>(row.outputs);
  const successCriteria = parseJsonField<string[]>(row.success_criteria);
  if (inputs !== undefined) role.inputs = inputs;
  if (outputs !== undefined) role.outputs = outputs;
  if (successCriteria !== undefined) role.successCriteria = successCriteria;
  return role;
}
