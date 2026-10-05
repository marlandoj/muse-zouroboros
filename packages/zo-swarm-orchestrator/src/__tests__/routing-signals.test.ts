import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoutingSignals } from '../routing/signals.js';
import { RoutingEngine } from '../routing/engine.js';
import { CircuitBreakerRegistry } from '../circuit/breaker.js';
import { closeDb } from '../db/schema.js';
import type { Task } from '../types.js';
const roots: string[] = [];
afterEach(() => {closeDb(); for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true});});
const task: Task = {id:'fixture',persona:'auto',task:'Review a fixture',priority:'medium',memoryMetadata:{category:'review'}};

test('persisted outcomes change both router variants and stay category-specific', () => {
  const root = mkdtempSync(join(tmpdir(),'routing-signals-')); roots.push(root);
  const path = join(root,'history.db');
  const signals = new RoutingSignals(path,join(root,'absent-memory.db'));
  expect(signals.history('a',task)).toBe(0.5);
  expect(signals.procedure('a',task)).toBe(0.5);
  for (let i=0;i<3;i++) {signals.record('a',task,false); signals.record('b',task,true);}
  closeDb();
  const restored = new RoutingSignals(path,join(root,'absent-memory.db'));
  expect(restored.history('a',task)).toBe(0);
  expect(restored.history('b',task)).toBe(1);
  expect(restored.history('b',{...task,memoryMetadata:{category:'coding'}})).toBe(0.5);
  const router = new RoutingEngine({strategy:'balanced',useSixSignal:true,
    circuitBreakers:new CircuitBreakerRegistry(),signals:restored,
    executorCapabilities:['a','b'].map(id=>({id,name:id,expertise:[],bestFor:[],isLocal:true}))});
  expect(router.route(task,'simple').executorId).toBe('b');
  expect(router.route(task,'simple',{roleExecutorId:'unrelated'}).executorId).toBe('b');
});

test('procedure score reflects existing memory outcomes without modifying memory', () => {
  const root = mkdtempSync(join(tmpdir(),'routing-procedures-')); roots.push(root);
  const memory = join(root,'memory.db');
  const db = new Database(memory);
  db.run('CREATE TABLE procedures (executor TEXT, category TEXT, outcome TEXT)');
  db.run("INSERT INTO procedures VALUES ('a','review','success'),('a','review','failure'),('a','coding','success'),('b','review','success')");
  db.close();
  const signals = new RoutingSignals(join(root,'history.db'),memory);
  expect(signals.procedure('a',task)).toBe(0.5);
  expect(signals.procedure('b',task)).toBe(1);
  expect(signals.procedure('unknown',task)).toBe(0.5);
  const check = new Database(memory,{readonly:true});
  expect(check.query('SELECT count(*) AS n FROM procedures').get()).toEqual({n:4});
  check.close();
});
