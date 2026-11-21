import { test, expect, describe } from 'bun:test';
import { runSmokeChecks, renderSmokeReport, type SmokeProbes } from './smoke-test.js';
import { buildFeatureList, type FeatureList } from './feature-list.js';

const FIXED = '2026-06-30T00:00:00.000Z';

function healthyLog(recordCount = 5): SmokeProbes {
  return { durableLog: () => ({ readable: true, recordCount }) };
}

function goodList(): FeatureList {
  return buildFeatureList('c', [{ id: 'f1', title: 't' }], { createdAt: FIXED });
}

function tamperedList(): FeatureList {
  const ok = goodList();
  return { ...ok, features: [{ id: 'f1', title: 'REWRITTEN' }] }; // stale hash now wrong
}

describe('runSmokeChecks', () => {
  test('all-green campaign ⇒ passed, no critical', () => {
    const rep = runSmokeChecks(
      { featureList: goodList(), transportCount: 2, flags: { SWARM_HARNESS_SMOKE: '1' } },
      healthyLog(),
    );
    expect(rep.passed).toBe(true);
    expect(rep.summary.critical).toBe(0);
    // one finding per check class
    expect(rep.findings.map(f => f.check).sort()).toEqual([
      'config-coherence',
      'durable-log',
      'feature-list-integrity',
      'transport',
    ]);
  });

  test('tampered feature-list ⇒ critical, not passed', () => {
    const rep = runSmokeChecks({ featureList: tamperedList(), transportCount: 1 }, healthyLog());
    const fl = rep.findings.find(f => f.check === 'feature-list-integrity')!;
    expect(fl.severity).toBe('critical');
    expect(rep.passed).toBe(false);
  });

  test('absent feature-list ⇒ graceful info skip', () => {
    const rep = runSmokeChecks({ transportCount: 1 }, healthyLog());
    const fl = rep.findings.find(f => f.check === 'feature-list-integrity')!;
    expect(fl.severity).toBe('info');
    expect(fl.message).toMatch(/no feature-list/);
    expect(rep.passed).toBe(true);
  });

  test('empty durable log ⇒ warning (still passes)', () => {
    const rep = runSmokeChecks(
      { transportCount: 1 },
      { durableLog: () => ({ readable: true, recordCount: 0 }) },
    );
    const log = rep.findings.find(f => f.check === 'durable-log')!;
    expect(log.severity).toBe('warning');
    expect(log.message).toMatch(/empty/);
    expect(rep.passed).toBe(true);
  });

  test('unreadable durable log ⇒ warning', () => {
    const rep = runSmokeChecks(
      { transportCount: 1 },
      { durableLog: () => ({ readable: false, recordCount: 0 }) },
    );
    const log = rep.findings.find(f => f.check === 'durable-log')!;
    expect(log.severity).toBe('warning');
    expect(log.message).toMatch(/unreadable/);
  });

  test('zero transports ⇒ critical, not passed', () => {
    const rep = runSmokeChecks({ transportCount: 0 }, healthyLog());
    const t = rep.findings.find(f => f.check === 'transport')!;
    expect(t.severity).toBe('critical');
    expect(rep.passed).toBe(false);
  });

  test('malformed enforce flag ⇒ config-coherence warning', () => {
    const rep = runSmokeChecks(
      { transportCount: 1, flags: { SWARM_HARNESS_SMOKE_ENFORCE: 'yes-please' } },
      healthyLog(),
    );
    const c = rep.findings.find(f => f.check === 'config-coherence')!;
    expect(c.severity).toBe('warning');
    expect(c.detail).toMatch(/SWARM_HARNESS_SMOKE_ENFORCE=yes-please/);
  });

  test('well-formed + undefined flags ⇒ config-coherence info', () => {
    const rep = runSmokeChecks(
      {
        transportCount: 1,
        flags: { A: '1', B: 'false', C: undefined, D: '' },
      },
      healthyLog(),
    );
    const c = rep.findings.find(f => f.check === 'config-coherence')!;
    expect(c.severity).toBe('info');
  });

  test('multiple criticals roll up, passed=false', () => {
    const rep = runSmokeChecks({ featureList: tamperedList(), transportCount: 0 }, healthyLog());
    expect(rep.summary.critical).toBe(2);
    expect(rep.passed).toBe(false);
  });
});

describe('renderSmokeReport', () => {
  test('renders all four checks with a PASS footer when healthy', () => {
    const out = renderSmokeReport(
      runSmokeChecks({ featureList: goodList(), transportCount: 1 }, healthyLog()),
    );
    expect(out).toContain('HARNESS SMOKE TEST');
    expect(out).toContain('[transport]');
    expect(out).toContain('✅ PASS');
  });

  test('renders FAIL footer when a critical is present', () => {
    const out = renderSmokeReport(runSmokeChecks({ transportCount: 0 }, healthyLog()));
    expect(out).toContain('❌ FAIL');
    expect(out).toContain('✗');
  });
});
