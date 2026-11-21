/**
 * Swarm API Server — embedded Hono server with SSE support.
 *
 * Exposes swarm state as REST endpoints + real-time SSE activity stream.
 * Registered as a Zo user service for persistent hosting.
 */

import { loadRegistry } from '../registry/loader.js';
import { readSharedCatalog,selectShared } from '../routing/shared-catalog.js';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createHash, timingSafeEqual } from 'node:crypto';
import { BudgetGovernor } from '../budget/governor.js';
import { HeartbeatScheduler } from '../heartbeat/scheduler.js';
import { RoleRegistry } from '../roles/registry.js';
import { selectExecutor } from '../selector/executor-selector.js';
import { getDb } from '../db/schema.js';
import type { Context } from 'hono';
import { validateTask, SchemaValidationError } from '../schemas/swarm-schemas.js';

export interface SwarmAPIConfig {
  port: number;
  authToken?: string;
  dbPath?: string;
}

export interface SSEEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

export function createSwarmAPI(config: SwarmAPIConfig) {
  const app = new Hono();
  const budget = new BudgetGovernor(config.dbPath);
  const heartbeat = new HeartbeatScheduler(config.dbPath);
  const roles = new RoleRegistry(config.dbPath);
  const db = getDb(config.dbPath);
  const executorIds=loadRegistry().executors.filter(e=>e.id!=='cursor').map(e=>e.id);

  const sseClients: Set<ReadableStreamDefaultController> = new Set();
  const eventLog: SSEEvent[] = [];

  const corsOrigins = (process.env.SWARM_API_CORS_ORIGINS || 'https://marlandoj.zo.space')
    .split(',').map(s => s.trim()).filter(Boolean);
  app.use('*', cors({ origin: corsOrigins }));

  if (config.authToken) {
    const expected = sha256(config.authToken);
    app.use('/api/swarm/*', async (c, next) => {
      const auth = c.req.header('authorization');
      const m = auth?.match(/^Bearer\s+(.+)$/i);
      if (!m || !timingSafeEqual(sha256(m[1]), expected)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      await next();
    });
  }

  function broadcastSSE(event: SSEEvent): void {
    eventLog.push(event);
    if (eventLog.length > 1000) eventLog.splice(0, eventLog.length - 500);
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const controller of sseClients) {
      try { controller.enqueue(new TextEncoder().encode(payload)); } catch { sseClients.delete(controller); }
    }
  }

  budget.on((evt) => broadcastSSE({ type: evt.type, data: evt.data, timestamp: evt.timestamp }));
  heartbeat.on((evt) => broadcastSSE({
    type: 'heartbeat',
    data: { swarmId: evt.swarmId, beat: evt.beatNumber, status: evt.status },
    timestamp: evt.timestamp,
  }));

  // --- Status ---
  app.get('/api/swarm/status', (c) => {
    return c.json({
      status: 'running',
      timestamp: Date.now(),
      executors: executorIds,
      heartbeats: {
        active: executorIds
          .filter(id => heartbeat.isRunning(id)),
      },
    });
  });

  app.get('/api/swarm/models', c => {
    const catalog=readSharedCatalog();
    return c.json({generatedAt:catalog?.generatedAt??null,sha256:catalog?.sha256??null,
      consumers:Object.fromEntries((['swarm','chat','automation','consensus','factory'] as const).map(consumer=>[consumer,selectShared(consumer,{catalog}).map(r=>({id:r.id,harness:r.harness,provider:r.provider,model:r.model,family:r.family,tier:r.tier,qualifiedAt:r.qualifications[consumer]?.at}))]))});
  });

  // --- Tasks ---
  app.get('/api/swarm/tasks', (c) => {
    const executor = c.req.query('executor');
    const status = c.req.query('status');
    // Tasks are managed by the orchestrator runtime; return from event log
    const taskEvents = eventLog.filter(e =>
      e.type.startsWith('task:') &&
      (!executor || e.data.executorId === executor) &&
      (!status || e.data.status === status)
    );
    return c.json({ tasks: taskEvents, count: taskEvents.length });
  });

  app.get('/api/swarm/tasks/:id', (c) => {
    const taskId = c.req.param('id');
    const events = eventLog.filter(e => e.data.taskId === taskId);
    return c.json({ taskId, events });
  });

  // --- Budget ---
  app.get('/api/swarm/budget', (c) => {
    const swarmId = c.req.query('swarmId') ?? 'default';
    const state = budget.getState(swarmId);
    return c.json(state);
  });

  app.post('/api/swarm/budget/init', async (c) => {
    const body = await c.req.json();
    budget.initSwarm({
      swarmId: body.swarmId ?? 'default',
      totalBudgetUSD: body.totalBudgetUSD,
      perExecutorLimits: body.perExecutorLimits,
      alertThresholdPct: body.alertThresholdPct,
      hardCapAction: body.hardCapAction ?? 'downgrade',
    });
    return c.json({ success: true });
  });

  // --- Health ---
  app.get('/api/swarm/health', (c) => {
    const executors = executorIds;
    const health: Record<string, unknown> = {};
    for (const id of executors) {
      health[id] = {
        state: 'CLOSED',
        failures: 0,
        heartbeatActive: heartbeat.isRunning(id),
        beatCount: heartbeat.getBeatCount(id),
      };
    }
    return c.json({ executors: health, timestamp: Date.now() });
  });

  // --- Roles CRUD ---
  app.get('/api/swarm/roles', (c) => {
    return c.json({ roles: roles.list() });
  });

  app.get('/api/swarm/roles/:id', (c) => {
    const role = roles.get(c.req.param('id'));
    if (!role) return c.json({ error: 'Role not found' }, 404);
    return c.json(role);
  });

  app.post('/api/swarm/roles', async (c) => {
    const body = await c.req.json();
    try {
      const role = roles.create(body);
      broadcastSSE({ type: 'role:created', data: { role }, timestamp: Date.now() });
      return c.json(role, 201);
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.put('/api/swarm/roles/:id', async (c) => {
    const body = await c.req.json();
    const updated = roles.update(c.req.param('id'), body);
    if (!updated) return c.json({ error: 'Role not found' }, 404);
    broadcastSSE({ type: 'role:updated', data: { role: updated }, timestamp: Date.now() });
    return c.json(updated);
  });

  app.delete('/api/swarm/roles/:id', (c) => {
    const deleted = roles.delete(c.req.param('id'));
    if (!deleted) return c.json({ error: 'Role not found' }, 404);
    broadcastSSE({ type: 'role:deleted', data: { roleId: c.req.param('id') }, timestamp: Date.now() });
    return c.json({ success: true });
  });

  // --- SSE Activity Stream ---
  app.get('/api/swarm/activity', (c) => {
    const stream = new ReadableStream({
      start(controller) {
        sseClients.add(controller);
        const recent = eventLog.slice(-20);
        for (const event of recent) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        }
      },
      cancel(controller) {
        sseClients.delete(controller);
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  });

  // --- Dispatch ---
  app.post('/api/swarm/dispatch', async (c) => {
    const body = await c.req.json();

    if (body.tasks && Array.isArray(body.tasks)) {
      try {
        for (const task of body.tasks) {
          validateTask(task);
        }
      } catch (err) {
        if (err instanceof SchemaValidationError) {
          return c.json({ error: `Invalid task payload: ${err.message}` }, 400);
        }
        throw err;
      }
    }

    const swarmId = body.swarmId ?? `swarm-${Date.now()}`;

    broadcastSSE({
      type: 'swarm:dispatched',
      data: { swarmId, taskCount: body.tasks?.length ?? 0 },
      timestamp: Date.now(),
    });

    return c.json({ swarmId, status: 'dispatched', message: 'Swarm dispatch queued' });
  });

  // --- Pause / Resume / Abort ---
  app.post('/api/swarm/pause/:taskId', (c) => {
    const taskId = c.req.param('taskId');
    broadcastSSE({ type: 'task:paused', data: { taskId }, timestamp: Date.now() });
    return c.json({ taskId, status: 'paused' });
  });

  app.post('/api/swarm/resume/:taskId', (c) => {
    const taskId = c.req.param('taskId');
    broadcastSSE({ type: 'task:resumed', data: { taskId }, timestamp: Date.now() });
    return c.json({ taskId, status: 'resumed' });
  });

  app.post('/api/swarm/abort/:swarmId', (c) => {
    const swarmId = c.req.param('swarmId');
    heartbeat.stop(swarmId);
    broadcastSSE({ type: 'swarm:aborted', data: { swarmId }, timestamp: Date.now() });
    return c.json({ swarmId, status: 'aborted' });
  });

  // --- Heartbeat control ---
  app.post('/api/swarm/heartbeat/start', async (c) => {
    const body = await c.req.json();
    heartbeat.start({
      swarmId: body.swarmId ?? 'default',
      intervalMs: body.intervalMs ?? 60000,
      maxBeats: body.maxBeats ?? 0,
      onIdle: body.onIdle ?? 'sleep',
    });
    return c.json({ success: true, swarmId: body.swarmId ?? 'default' });
  });

  app.post('/api/swarm/heartbeat/stop', async (c) => {
    const body = await c.req.json();
    heartbeat.stop(body.swarmId ?? 'default');
    return c.json({ success: true });
  });

  return { app, budget, heartbeat, roles, broadcastSSE };
}

export function startSwarmServer(config?: Partial<SwarmAPIConfig>): void {
  const port = config?.port ?? parseInt(process.env.PORT ?? '3847', 10);
  const authToken = config?.authToken ?? process.env.SWARM_API_TOKEN;
  const dbPath = config?.dbPath;

  const { app } = createSwarmAPI({ port, authToken, dbPath });

  Bun.serve({ port, hostname: process.env.SWARM_API_HOST || '127.0.0.1', fetch: app.fetch });
  console.log(`Swarm API server listening on port ${port}`);
}

if (import.meta.main) {
  startSwarmServer();
}
