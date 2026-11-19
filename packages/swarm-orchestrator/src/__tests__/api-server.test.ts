import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createSwarmAPI } from '../api/server.js';
import { closeDb } from '../db/schema.js';
import { unlinkSync, existsSync } from 'fs';

const TEST_DB = '/tmp/swarm-test-api.db';

let app: ReturnType<typeof createSwarmAPI>['app'];

beforeEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  const api = createSwarmAPI({ port: 0, dbPath: TEST_DB });
  app = api.app;
});

afterEach(() => {
  closeDb();
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

async function req(path: string, opts?: RequestInit) {
  return app.request(path, opts);
}

describe('Swarm API Server', () => {
  test('GET /api/swarm/status returns running', async () => {
    const res = await req('/api/swarm/status');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('running');
    expect(body.executors).toContain('claude-code');
  });

  test('GET /api/swarm/health returns executor grid', async () => {
    const res = await req('/api/swarm/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.executors).toBeDefined();
    expect(body.executors['claude-code']).toBeDefined();
    expect(body.executors['gemini']).toBeDefined();
  });

  test('GET /api/swarm/roles returns seeded roles', async () => {
    const res = await req('/api/swarm/roles');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.roles.length).toBeGreaterThanOrEqual(6);
  });

  test('POST /api/swarm/roles creates a role', async () => {
    const res = await req('/api/swarm/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'test-role',
        name: 'Test Role',
        executorId: 'hermes',
        tags: ['test'],
        description: 'A test role',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe('test-role');
  });

  test('PUT /api/swarm/roles/:id updates a role', async () => {
    const res = await req('/api/swarm/roles/senior-architect', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'sonnet' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBe('sonnet');
  });

  test('DELETE /api/swarm/roles/:id deletes a role', async () => {
    const res = await req('/api/swarm/roles/junior-developer', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const verify = await req('/api/swarm/roles/junior-developer');
    expect(verify.status).toBe(404);
  });

  test('GET /api/swarm/budget returns state', async () => {
    const res = await req('/api/swarm/budget');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalSpentUSD).toBeDefined();
  });

  test('POST /api/swarm/budget/init sets budget', async () => {
    const res = await req('/api/swarm/budget/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ swarmId: 'test', totalBudgetUSD: 50.0 }),
    });
    expect(res.status).toBe(200);
    const budgetRes = await req('/api/swarm/budget?swarmId=test');
    const body = await budgetRes.json();
    expect(body.totalBudgetUSD).toBe(50.0);
  });

  test('GET /api/swarm/tasks returns empty initially', async () => {
    const res = await req('/api/swarm/tasks');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(0);
  });

  test('POST /api/swarm/dispatch returns swarmId', async () => {
    const res = await req('/api/swarm/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks: [{ id: 't1', task: 'test', persona: 'default', priority: 'medium' }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.swarmId).toBeDefined();
    expect(body.status).toBe('dispatched');
  });

  test('POST /api/swarm/pause/:taskId pauses task', async () => {
    const res = await req('/api/swarm/pause/t1', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('paused');
  });

  test('POST /api/swarm/abort/:swarmId aborts', async () => {
    const res = await req('/api/swarm/abort/s1', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('aborted');
  });

  test('GET /api/swarm/activity returns SSE stream', async () => {
    const res = await req('/api/swarm/activity');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
  });

  test('auth middleware rejects bad token when configured', async () => {
    closeDb();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    const securedApi = createSwarmAPI({ port: 0, authToken: 'secret123', dbPath: TEST_DB });
    const res = await securedApi.app.request('/api/swarm/status', {
      headers: { authorization: 'Bearer wrongtoken' },
    });
    expect(res.status).toBe(401);
  });

  test('auth middleware accepts correct token', async () => {
    closeDb();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    const securedApi = createSwarmAPI({ port: 0, authToken: 'secret123', dbPath: TEST_DB });
    const res = await securedApi.app.request('/api/swarm/status', {
      headers: { authorization: 'Bearer secret123' },
    });
    expect(res.status).toBe(200);
  });
});
