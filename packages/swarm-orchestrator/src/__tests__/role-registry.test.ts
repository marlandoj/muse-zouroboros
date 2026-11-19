import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { RoleRegistry } from '../roles/registry.js';
import { closeDb } from '../db/schema.js';
import { unlinkSync, existsSync } from 'fs';

const TEST_DB = '/tmp/swarm-test-roles.db';

let registry: RoleRegistry;

beforeEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  registry = new RoleRegistry(TEST_DB);
});

afterEach(() => {
  closeDb();
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

describe('Role Registry', () => {
  test('seeds default roles on init', () => {
    const roles = registry.list();
    expect(roles.length).toBeGreaterThanOrEqual(6);
    const ids = roles.map(r => r.id);
    expect(ids).toContain('senior-architect');
    expect(ids).toContain('ui-developer');
    expect(ids).toContain('backend-developer');
    expect(ids).toContain('researcher');
    expect(ids).toContain('junior-developer');
    expect(ids).toContain('ops-engineer');
  });

  test('gets a role by id', () => {
    const role = registry.get('senior-architect');
    expect(role).not.toBeNull();
    expect(role!.executorId).toBe('claude-code');
    expect(role!.tags).toContain('reasoning');
  });

  test('creates a new role', () => {
    const role = registry.create({
      id: 'data-analyst',
      name: 'Data Analyst',
      executorId: 'hermes',
      model: 'byok',
      tags: ['data', 'analysis', 'sql'],
      description: 'Data analysis and SQL queries',
    });
    expect(role.id).toBe('data-analyst');
    expect(role.executorId).toBe('hermes');
    const fetched = registry.get('data-analyst');
    expect(fetched).not.toBeNull();
  });

  test('updates an existing role', () => {
    const updated = registry.update('senior-architect', { model: 'sonnet' });
    expect(updated).not.toBeNull();
    expect(updated!.model).toBe('sonnet');
    expect(updated!.executorId).toBe('claude-code');
  });

  test('deletes a role', () => {
    const result = registry.delete('junior-developer');
    expect(result).toBe(true);
    expect(registry.get('junior-developer')).toBeNull();
  });

  test('delete returns false for nonexistent', () => {
    expect(registry.delete('nonexistent')).toBe(false);
  });

  test('resolves role to executor', () => {
    const resolution = registry.resolve('ui-developer');
    expect(resolution).not.toBeNull();
    expect(resolution!.executorId).toBe('gemini');
    expect(resolution!.roleId).toBe('ui-developer');
  });

  test('resolve returns null for missing role', () => {
    expect(registry.resolve('nonexistent')).toBeNull();
  });

  test('finds roles by tag', () => {
    const results = registry.findByTag('research');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].executorId).toBe('hermes');
  });

  test('update returns null for nonexistent role', () => {
    const result = registry.update('nonexistent', { name: 'foo' });
    expect(result).toBeNull();
  });

  test('role tags are proper arrays', () => {
    const role = registry.get('senior-architect');
    expect(Array.isArray(role!.tags)).toBe(true);
    expect(role!.tags.length).toBeGreaterThan(0);
  });
});
