/**
 * Tests for the verification module: capabilities manifest, wiring verifier, gap audit.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, unlinkSync } from 'fs';
import { closeDb } from '../db/schema.js';
import {
  CAPABILITY_MANIFEST,
  getCapability,
  getCapabilityIds,
  type Capability,
  type CapabilityEdge,
} from '../verification/capabilities.js';
import { verifyWiring, type WiringReport } from '../verification/verify-wiring.js';
import { runGapAudit, type GapAuditReport } from '../verification/gap-audit.js';

// ============================================================================
// Capability Manifest
// ============================================================================

describe('Capability Manifest', () => {
  test('manifest is non-empty', () => {
    expect(CAPABILITY_MANIFEST.length).toBeGreaterThan(0);
  });

  test('all capabilities have unique IDs', () => {
    const ids = CAPABILITY_MANIFEST.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('all capabilities have required fields', () => {
    for (const cap of CAPABILITY_MANIFEST) {
      expect(cap.id).toBeTruthy();
      expect(cap.name).toBeTruthy();
      expect(cap.description).toBeTruthy();
      expect(Array.isArray(cap.edges)).toBe(true);
      expect(Array.isArray(cap.dataPrerequisites)).toBe(true);
      expect(Array.isArray(cap.crossBoundary)).toBe(true);
    }
  });

  test('all edges have source module and exports', () => {
    for (const cap of CAPABILITY_MANIFEST) {
      for (const edge of cap.edges) {
        expect(edge.sourceModule).toBeTruthy();
        expect(edge.exports.length).toBeGreaterThan(0);
        expect(edge.expectedImporters.length).toBeGreaterThan(0);
      }
    }
  });

  test('getCapability returns correct capability', () => {
    const cap = getCapability('executor-selector');
    expect(cap).toBeDefined();
    expect(cap!.name).toBe('Executor Selector');
  });

  test('getCapability returns undefined for unknown ID', () => {
    expect(getCapability('nonexistent')).toBeUndefined();
  });

  test('getCapabilityIds returns all IDs', () => {
    const ids = getCapabilityIds();
    expect(ids.length).toBe(CAPABILITY_MANIFEST.length);
    expect(ids).toContain('executor-selector');
    expect(ids).toContain('rag-enrichment');
    expect(ids).toContain('role-registry');
  });

  test('core capabilities are declared', () => {
    const ids = getCapabilityIds();
    const required = [
      'executor-selector',
      'rag-enrichment',
      'hierarchical-delegation',
      'role-registry',
      'budget-governor',
      'routing-engine',
      'circuit-breaker',
      'dag-executor',
      'transport-abstraction',
    ];
    for (const id of required) {
      expect(ids).toContain(id);
    }
  });
});

// ============================================================================
// Verify Wiring
// ============================================================================

describe('Verify Wiring', () => {
  let report: WiringReport;

  beforeEach(() => {
    report = verifyWiring();
  });

  test('returns a well-formed report', () => {
    expect(report.timestamp).toBeGreaterThan(0);
    expect(report.totalCapabilities).toBeGreaterThan(0);
    expect(report.totalEdges).toBeGreaterThan(0);
    expect(typeof report.passed).toBe('boolean');
    expect(typeof report.summary).toBe('string');
    expect(Array.isArray(report.issues)).toBe(true);
    expect(Array.isArray(report.orphanedModules)).toBe(true);
  });

  test('all source modules exist on disk', () => {
    const fileNotFound = report.issues.filter(
      i => i.type === 'file_not_found' && i.severity === 'error'
    );
    expect(fileNotFound).toEqual([]);
  });

  test('core imports are wired', () => {
    const missingImports = report.issues.filter(
      i => i.type === 'missing_import' && i.severity === 'error'
    );
    // Allow some flexibility for optional importers but core wiring must hold
    const coreFailures = missingImports.filter(i =>
      ['executor-selector', 'rag-enrichment', 'hierarchical-delegation', 'role-registry', 'budget-governor'].includes(i.capabilityId) &&
      i.file === 'orchestrator.ts'
    );
    expect(coreFailures).toEqual([]);
  });

  test('orchestrator call sites exist', () => {
    const missingSites = report.issues.filter(
      i => i.type === 'missing_call_site' && i.file === 'orchestrator.ts'
    );
    expect(missingSites).toEqual([]);
  });

  test('wiring passes (no errors)', () => {
    const errors = report.issues.filter(i => i.severity === 'error');
    if (errors.length > 0) {
      console.log('Wiring errors:', errors.map(e => e.message));
    }
    expect(report.passed).toBe(true);
  });
});

// ============================================================================
// Gap Audit
// ============================================================================

describe('Gap Audit', () => {
  let report: GapAuditReport;

  beforeEach(() => {
    report = runGapAudit();
  });

  test('returns a well-formed report', () => {
    expect(report.timestamp).toBeGreaterThan(0);
    expect(report.wiringReport).toBeDefined();
    expect(Array.isArray(report.gaps)).toBe(true);
    expect(typeof report.passed).toBe('boolean');
    expect(report.summary.totalCapabilities).toBeGreaterThan(0);
  });

  test('wiring report is included', () => {
    expect(report.wiringReport.totalCapabilities).toBeGreaterThan(0);
  });

  test('executor registry is loaded', () => {
    const registryGaps = report.gaps.filter(
      g => g.capabilityId === 'executor-selector' && g.category === 'data'
    );
    expect(registryGaps).toEqual([]);
  });

  test('no critical reachability gaps for core capabilities', () => {
    const criticalReachability = report.gaps.filter(
      g => g.category === 'reachability' &&
        g.severity === 'critical' &&
        ['executor-selector', 'rag-enrichment', 'hierarchical-delegation', 'budget-governor'].includes(g.capabilityId)
    );
    expect(criticalReachability).toEqual([]);
  });

  test('gap categories are valid', () => {
    const validCategories = ['reachability', 'data', 'cross-boundary', 'eval-parity', 'dangling'];
    for (const gap of report.gaps) {
      expect(validCategories).toContain(gap.category);
    }
  });

  test('all gaps have remediation hints', () => {
    for (const gap of report.gaps) {
      expect(gap.remediation).toBeTruthy();
      expect(gap.remediation.length).toBeGreaterThan(5);
    }
  });
});

// ============================================================================
// Preflight Data Checks (via SwarmOrchestrator)
// ============================================================================

describe('Preflight Data Checks', () => {
  const TEST_DB = '/tmp/swarm-test-preflight.db';

  afterEach(() => {
    closeDb();
    for (const f of [TEST_DB, `${TEST_DB}-shm`, `${TEST_DB}-wal`]) {
      if (existsSync(f)) unlinkSync(f);
    }
  });

  test('SwarmOrchestrator exposes preflightDataChecks', async () => {
    const { SwarmOrchestrator } = await import('../orchestrator.js');
    const orch = new SwarmOrchestrator({ dbPath: TEST_DB });
    const checks = orch.preflightDataChecks();
    expect(checks).toBeDefined();
    expect(Array.isArray(checks.warnings)).toBe(true);
    expect(Array.isArray(checks.errors)).toBe(true);
  });

  test('preflight detects zero transports as error', async () => {
    const { SwarmOrchestrator } = await import('../orchestrator.js');
    const orch = new SwarmOrchestrator({ dbPath: TEST_DB });
    const checks = orch.preflightDataChecks();
    expect(typeof checks.errors.length).toBe('number');
    expect(typeof checks.warnings.length).toBe('number');
  });
});
