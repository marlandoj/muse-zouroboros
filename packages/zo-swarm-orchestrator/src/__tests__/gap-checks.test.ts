import { describe, test, expect } from 'bun:test';
import { isBenchOrTestPath, detectEvalParityGaps, detectDuplicateExports } from '../verification/gap-checks.js';

describe('gap audit checks 4-5 (plan §7)', () => {
  test('bench/test path classification', () => {
    expect(isBenchOrTestPath('cli/t3-run.ts')).toBe(true);
    expect(isBenchOrTestPath('foo.test.ts')).toBe(true);
    expect(isBenchOrTestPath('scripts/bench.ts')).toBe(true);
    expect(isBenchOrTestPath('orchestrator.ts')).toBe(false);
  });

  test('eval-parity flags capabilities only invoked from bench paths', () => {
    const caps = [
      { id: 'bench-only', edges: [{ sourceModule: 'x.ts', exports: ['X'], callSites: [{ file: 'cli/t3-run.ts', pattern: 'X\\(' }] }] },
      { id: 'prod', edges: [{ sourceModule: 'y.ts', exports: ['Y'], callSites: [{ file: 'orchestrator.ts', pattern: 'Y\\(' }] }] },
      { id: 'unwired', edges: [{ sourceModule: 'z.ts', exports: ['Z'], callSites: [{ file: 'orchestrator.ts', pattern: 'Z\\(' }] }] },
    ];
    const gaps = detectEvalParityGaps(caps, (file, pattern) => !(file === 'orchestrator.ts' && pattern === 'Z\\('));
    expect(gaps.map((g) => g.capabilityId)).toEqual(['bench-only']);
  });

  test('duplicate exports across modules are detected', () => {
    const dups = detectDuplicateExports([
      { path: 'a.ts', content: 'export function runQualityGate() {}' },
      { path: 'b.ts', content: 'export const runQualityGate = 1; export function unique() {}' },
      { path: 'c.ts', content: 'export function unique2() {}' },
    ]);
    expect(dups).toEqual([{ symbol: 'runQualityGate', files: ['a.ts', 'b.ts'] }]);
  });
});
