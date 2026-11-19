import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { RoleRegistry } from '../roles/registry.js';
import { categoryToSOP, inferCategoryFromPath, mapCategoryToExecutor, personaNameToRoleId } from '../roles/persona-seeder.js';
import { getDb, closeDb } from '../db/schema.js';
import { unlinkSync, existsSync } from 'fs';

const TEST_DB = '/tmp/swarm-test-role-sop.db';

function clean() {
  closeDb();
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
}

beforeEach(clean);
afterEach(clean);

describe('MetaGPT SOP — schema migration', () => {
  test('migration is idempotent', () => {
    getDb(TEST_DB);
    closeDb();
    // Re-open: ensureSchema runs again on populated DB. Should not error.
    const db = getDb(TEST_DB);
    const cols = db.query(`PRAGMA table_info(swarm_roles)`).all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain('inputs');
    expect(names).toContain('outputs');
    expect(names).toContain('success_criteria');
    // Should be exactly one of each (no duplicates from re-running migration)
    expect(names.filter((n) => n === 'inputs').length).toBe(1);
    expect(names.filter((n) => n === 'outputs').length).toBe(1);
    expect(names.filter((n) => n === 'success_criteria').length).toBe(1);
  });

  test('migration on legacy DB adds the three columns', () => {
    closeDb();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    // Hand-build a legacy schema (pre-SOP) directly
    const legacy = new Database(TEST_DB);
    legacy.run(`
      CREATE TABLE swarm_roles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        executor_id TEXT NOT NULL,
        model TEXT,
        tags TEXT,
        description TEXT,
        budget_cap_usd REAL,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      )
    `);
    legacy.run(
      `INSERT INTO swarm_roles (id, name, executor_id, tags, description) VALUES (?, ?, ?, ?, ?)`,
      ['legacy-role', 'Legacy Role', 'claude-code', '["legacy"]', 'pre-existing role']
    );
    legacy.close();

    // Now boot through getDb — ensureSchema should add the columns idempotently
    const db = getDb(TEST_DB);
    const cols = db.query(`PRAGMA table_info(swarm_roles)`).all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain('inputs');
    expect(names).toContain('outputs');
    expect(names).toContain('success_criteria');

    // Legacy row preserved
    const row = db.query(`SELECT id, inputs, outputs, success_criteria FROM swarm_roles WHERE id = ?`).get('legacy-role') as
      | { id: string; inputs: string | null; outputs: string | null; success_criteria: string | null }
      | null;
    expect(row).not.toBeNull();
    expect(row!.inputs).toBeNull();
    expect(row!.outputs).toBeNull();
    expect(row!.success_criteria).toBeNull();
  });
});

describe('MetaGPT SOP — Role CRUD round-trip', () => {
  test('CRUD round-trip with full SOP', () => {
    const registry = new RoleRegistry(TEST_DB);
    const created = registry.create({
      id: 'sop-architect',
      name: 'SOP Architect',
      executorId: 'claude-code',
      model: 'opus',
      tags: ['sop', 'architecture'],
      description: 'Architect with full SOP contract',
      inputs: { requirements: 'string', constraints: 'array' },
      outputs: { design_doc: 'string', interfaces: 'array' },
      successCriteria: ['design_doc not empty', 'interfaces length >= 1'],
    });
    expect(created.inputs).toEqual({ requirements: 'string', constraints: 'array' });
    expect(created.outputs).toEqual({ design_doc: 'string', interfaces: 'array' });
    expect(created.successCriteria).toEqual(['design_doc not empty', 'interfaces length >= 1']);

    // List should include the SOP fields
    const fetched = registry.get('sop-architect');
    expect(fetched).not.toBeNull();
    expect(fetched!.inputs).toEqual({ requirements: 'string', constraints: 'array' });
    expect(fetched!.successCriteria).toEqual(['design_doc not empty', 'interfaces length >= 1']);

    // Update SOP
    const updated = registry.update('sop-architect', {
      successCriteria: ['design_doc not empty', 'interfaces length >= 2'],
    });
    expect(updated!.successCriteria).toEqual(['design_doc not empty', 'interfaces length >= 2']);
    // Untouched fields preserved
    expect(updated!.inputs).toEqual({ requirements: 'string', constraints: 'array' });
  });

  test('grandfathered role with NULL contracts', () => {
    const registry = new RoleRegistry(TEST_DB);
    const created = registry.create({
      id: 'grandfathered',
      name: 'Grandfathered Role',
      executorId: 'claude-code',
      tags: ['legacy'],
      description: 'No SOP set',
    });
    expect(created.inputs).toBeUndefined();
    expect(created.outputs).toBeUndefined();
    expect(created.successCriteria).toBeUndefined();

    const fetched = registry.get('grandfathered');
    expect(fetched!.inputs).toBeUndefined();
    expect(fetched!.outputs).toBeUndefined();
    expect(fetched!.successCriteria).toBeUndefined();
  });

  test('bulkCreate persists SOP fields', () => {
    const registry = new RoleRegistry(TEST_DB);
    const inserted = registry.bulkCreate([
      {
        id: 'bulk-a',
        name: 'Bulk A',
        executorId: 'claude-code',
        tags: ['bulk'],
        description: 'with SOP',
        inputs: { x: 'string' },
        outputs: { y: 'string' },
        successCriteria: ['y not empty'],
      },
      {
        id: 'bulk-b',
        name: 'Bulk B',
        executorId: 'claude-code',
        tags: ['bulk'],
        description: 'without SOP',
      },
    ]);
    expect(inserted).toBe(2);
    const a = registry.get('bulk-a')!;
    const b = registry.get('bulk-b')!;
    expect(a.inputs).toEqual({ x: 'string' });
    expect(a.successCriteria).toEqual(['y not empty']);
    expect(b.inputs).toBeUndefined();
    expect(b.successCriteria).toBeUndefined();
  });
});

describe('MetaGPT SOP — enforcement flag', () => {
  test('enforcement defaults to soft', () => {
    const registry = new RoleRegistry(TEST_DB);
    expect(registry.enforcement).toBe('soft');
  });

  test('enforcement can be set to hard via config', () => {
    const registry = new RoleRegistry(TEST_DB, { enforcement: 'hard' });
    expect(registry.enforcement).toBe('hard');
  });
});

describe('MetaGPT SOP — coverage helpers', () => {
  test('countWithSOP only counts roles with all three contract fields set', () => {
    const registry = new RoleRegistry(TEST_DB);
    const baseline = registry.countWithSOP(); // default seed roles
    registry.create({
      id: 'full-sop',
      name: 'Full',
      executorId: 'claude-code',
      tags: [],
      description: 'all three set',
      inputs: { a: 'string' },
      outputs: { b: 'string' },
      successCriteria: ['ok'],
    });
    registry.create({
      id: 'partial-sop',
      name: 'Partial',
      executorId: 'claude-code',
      tags: [],
      description: 'inputs only',
      inputs: { a: 'string' },
    });
    registry.create({
      id: 'no-sop',
      name: 'None',
      executorId: 'claude-code',
      tags: [],
      description: 'nothing',
    });
    expect(registry.countWithSOP()).toBe(baseline + 1);
  });
});

// ── Cycle B ────────────────────────────────────────────────────────────────

describe('MetaGPT SOP Cycle B — categoryToSOP backfill', () => {
  test('uses catalog tier names for seeded role models', () => {
    expect(mapCategoryToExecutor('engineering')).toEqual({ executorId: 'claude-code', model: 'mid' });
    expect(mapCategoryToExecutor('design')).toEqual({ executorId: 'gemini', model: 'heavy' });
    expect(mapCategoryToExecutor('unknown-category')).toEqual({ executorId: 'claude-code', model: 'mid' });
  });

  test('every known category returns a full SOP contract', () => {
    const categories = [
      'engineering', 'design', 'marketing', 'product',
      'project-management', 'spatial-computing', 'specialized', 'support', 'testing',
    ];
    for (const cat of categories) {
      const sop = categoryToSOP(cat);
      expect(Object.keys(sop.inputs).length).toBeGreaterThan(0);
      expect(Object.keys(sop.outputs).length).toBeGreaterThan(0);
      expect(sop.successCriteria.length).toBeGreaterThan(0);
    }
  });

  test('unknown category falls back to specialized SOP', () => {
    const sop = categoryToSOP('unknown-category');
    expect(sop.inputs).toBeDefined();
    expect(sop.successCriteria.length).toBeGreaterThan(0);
  });

  test('seeded role via bulkCreate with SOP fields is fully populated', () => {
    const registry = new RoleRegistry(TEST_DB);
    const baseline = registry.countWithSOP();
    const category = 'engineering';
    const sop = categoryToSOP(category);
    registry.bulkCreate([
      {
        id: 'test-engineer',
        name: 'Test Engineer',
        executorId: 'claude-code',
        model: 'sonnet',
        tags: [category],
        description: 'Test Engineer from engineering agency',
        inputs: sop.inputs,
        outputs: sop.outputs,
        successCriteria: sop.successCriteria,
      },
    ]);
    const role = registry.get('test-engineer')!;
    expect(role.inputs).toEqual(sop.inputs);
    expect(role.outputs).toEqual(sop.outputs);
    expect(role.successCriteria).toEqual(sop.successCriteria);
    expect(registry.countWithSOP()).toBe(baseline + 1);
  });

  test('inferCategoryFromPath extracts category segment', () => {
    expect(inferCategoryFromPath('/home/workspace/agency-agents/engineering/foo.md')).toBe('engineering');
    expect(inferCategoryFromPath('/home/workspace/agency-agents/marketing/bar.md')).toBe('marketing');
    expect(inferCategoryFromPath('/no/match/here')).toBe('specialized');
  });

  test('personaNameToRoleId produces valid slug', () => {
    expect(personaNameToRoleId('Senior Engineer')).toBe('senior-engineer');
    expect(personaNameToRoleId('  Lead QA Tester  ')).toBe('lead-qa-tester');
    expect(personaNameToRoleId('UX/UI Designer')).toBe('uxui-designer');
  });
});

describe('MetaGPT SOP Cycle B — validateSOPContract', () => {
  test('valid role passes', () => {
    const registry = new RoleRegistry(TEST_DB);
    const role = registry.create({
      id: 'valid-role',
      name: 'Valid',
      executorId: 'claude-code',
      tags: [],
      description: 'all set',
      inputs: { a: 'string' },
      outputs: { b: 'string' },
      successCriteria: ['b non-empty'],
    });
    const result = registry.validateSOPContract(role);
    expect(result.valid).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  test('role missing all three fields fails with all listed', () => {
    const registry = new RoleRegistry(TEST_DB);
    const role = registry.create({
      id: 'bare-role',
      name: 'Bare',
      executorId: 'claude-code',
      tags: [],
      description: 'nothing',
    });
    const result = registry.validateSOPContract(role);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain('inputs');
    expect(result.missing).toContain('outputs');
    expect(result.missing).toContain('successCriteria');
  });

  test('role missing only outputs fails with outputs listed', () => {
    const registry = new RoleRegistry(TEST_DB);
    const role = registry.create({
      id: 'partial-role',
      name: 'Partial',
      executorId: 'claude-code',
      tags: [],
      description: 'inputs + criteria only',
      inputs: { x: 'string' },
      successCriteria: ['ok'],
    });
    const result = registry.validateSOPContract(role);
    expect(result.valid).toBe(false);
    expect(result.missing).toEqual(['outputs']);
  });
});

describe('MetaGPT SOP Cycle B — default-role backfill migration', () => {
  test('fresh DB seeds the 7 default roles with full SOP contracts', () => {
    const registry = new RoleRegistry(TEST_DB);
    const defaults = [
      'senior-architect', 'ui-developer', 'backend-developer',
      'researcher', 'junior-developer', 'ops-engineer', 'memory-sage',
    ];
    for (const id of defaults) {
      const role = registry.get(id);
      expect(role).not.toBeNull();
      expect(role!.inputs && Object.keys(role!.inputs).length).toBeGreaterThan(0);
      expect(role!.outputs && Object.keys(role!.outputs).length).toBeGreaterThan(0);
      expect(role!.successCriteria && role!.successCriteria.length).toBeGreaterThan(0);
      const v = registry.validateSOPContract(role!);
      expect(v.valid).toBe(true);
    }
    expect(registry.countWithSOP()).toBeGreaterThanOrEqual(7);
  });

  test('legacy DB with NULL SOPs on default roles is backfilled on next boot', () => {
    closeDb();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    // Hand-build a legacy DB: full current schema, but default roles inserted
    // WITHOUT SOP columns populated (simulates pre-Cycle-B production state)
    const legacy = new Database(TEST_DB);
    legacy.run(`
      CREATE TABLE swarm_roles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        executor_id TEXT NOT NULL,
        model TEXT,
        tags TEXT,
        description TEXT,
        budget_cap_usd REAL,
        inputs TEXT,
        outputs TEXT,
        success_criteria TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      )
    `);
    legacy.run(
      `INSERT INTO swarm_roles (id, name, executor_id, model, tags, description) VALUES (?, ?, ?, ?, ?, ?)`,
      ['senior-architect', 'Senior Architect', 'claude-code', 'opus', '["reasoning"]', 'pre-cycle-b']
    );
    legacy.run(
      `INSERT INTO swarm_roles (id, name, executor_id, model, tags, description) VALUES (?, ?, ?, ?, ?, ?)`,
      ['memory-sage', 'Memory Sage (Mimir)', 'mimir', null, '["memory","mimir"]', 'pre-cycle-b']
    );
    legacy.close();

    // Boot through getDb — backfill should populate SOP fields on these rows
    const registry = new RoleRegistry(TEST_DB);
    const arch = registry.get('senior-architect')!;
    const sage = registry.get('memory-sage')!;
    expect(arch.inputs).toBeDefined();
    expect(arch.outputs).toBeDefined();
    expect(arch.successCriteria).toBeDefined();
    expect(registry.validateSOPContract(arch).valid).toBe(true);
    expect(sage.inputs).toBeDefined();
    expect(registry.validateSOPContract(sage).valid).toBe(true);
    expect(sage.name).toBe('Memory Sage');
    expect(sage.executorId).toBe('hermes');
    expect(sage.tags).not.toContain('mimir');
    // Non-default rows shouldn't be created by backfill
    expect(registry.count()).toBe(2);
  });

  test('backfill preserves operator-supplied custom SOP fields', () => {
    closeDb();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    const legacy = new Database(TEST_DB);
    legacy.run(`
      CREATE TABLE swarm_roles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        executor_id TEXT NOT NULL,
        model TEXT,
        tags TEXT,
        description TEXT,
        budget_cap_usd REAL,
        inputs TEXT,
        outputs TEXT,
        success_criteria TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      )
    `);
    // Insert ui-developer with a CUSTOM inputs payload — backfill must not overwrite
    legacy.run(
      `INSERT INTO swarm_roles (id, name, executor_id, model, tags, description, inputs) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['ui-developer', 'UI Developer', 'gemini', 'pro', '["ui"]', 'custom', '{"custom_field":"string"}']
    );
    legacy.close();

    const registry = new RoleRegistry(TEST_DB);
    const role = registry.get('ui-developer')!;
    // Custom inputs preserved
    expect(role.inputs).toEqual({ custom_field: 'string' });
    // Missing outputs + success_criteria filled in by backfill
    expect(role.outputs).toBeDefined();
    expect(role.successCriteria).toBeDefined();
  });

  test('backfill is idempotent across multiple boots', () => {
    const r1 = new RoleRegistry(TEST_DB);
    const arch1 = r1.get('senior-architect')!;
    const initialUpdatedAt = arch1.updatedAt;
    closeDb();
    // Re-boot
    const r2 = new RoleRegistry(TEST_DB);
    const arch2 = r2.get('senior-architect')!;
    // SOP fields stable
    expect(arch2.inputs).toEqual(arch1.inputs);
    expect(arch2.outputs).toEqual(arch1.outputs);
    expect(arch2.successCriteria).toEqual(arch1.successCriteria);
    // Second backfill should not have re-stamped updated_at (NULL guard filters the row out)
    expect(arch2.updatedAt).toBe(initialUpdatedAt);
  });
});

describe('MetaGPT SOP Cycle B — hard enforcement', () => {
  test('resolve throws on hard enforcement for role without SOP', () => {
    const registry = new RoleRegistry(TEST_DB, { enforcement: 'hard' });
    registry.create({
      id: 'no-sop-role',
      name: 'No SOP',
      executorId: 'claude-code',
      tags: [],
      description: 'missing contracts',
    });
    expect(() => registry.resolve('no-sop-role')).toThrow(/SOP enforcement=hard/);
    expect(() => registry.resolve('no-sop-role')).toThrow(/inputs/);
  });

  test('resolve succeeds on hard enforcement for fully-populated role', () => {
    const registry = new RoleRegistry(TEST_DB, { enforcement: 'hard' });
    registry.create({
      id: 'full-sop-role',
      name: 'Full SOP',
      executorId: 'claude-code',
      tags: [],
      description: 'all set',
      inputs: { a: 'string' },
      outputs: { b: 'string' },
      successCriteria: ['b non-empty'],
    });
    const resolution = registry.resolve('full-sop-role');
    expect(resolution).not.toBeNull();
    expect(resolution!.executorId).toBe('claude-code');
  });

  test('soft enforcement resolve does not throw for role without SOP', () => {
    const registry = new RoleRegistry(TEST_DB, { enforcement: 'soft' });
    registry.create({
      id: 'soft-no-sop',
      name: 'Soft No SOP',
      executorId: 'claude-code',
      tags: [],
      description: 'missing contracts — ok in soft mode',
    });
    expect(() => registry.resolve('soft-no-sop')).not.toThrow();
    const resolution = registry.resolve('soft-no-sop');
    expect(resolution).not.toBeNull();
  });

  test('resolve returns null for non-existent role regardless of enforcement', () => {
    const hard = new RoleRegistry(TEST_DB, { enforcement: 'hard' });
    expect(hard.resolve('ghost-role')).toBeNull();
  });
});
