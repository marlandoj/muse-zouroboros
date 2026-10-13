/**
 * supply-chain-stub.ts — Faithful local reimplementation of the
 * skill-security-gate supply-chain attestation digest helper.
 *
 * The upstream module (Skills/skill-security-gate/scripts/supply-chain/
 * attestation.ts) is not vendored in this distribution. `sourceDigest` is a
 * pure function (stable canonicalization + sha256), reimplemented here
 * verbatim in behavior so digest comparisons in factory-supply-chain.ts keep
 * working.
 */

import { createHash } from 'node:crypto';

export interface SupplyChainAttestation {
  reviewRequired: boolean;
  sourceDigest: string;
  [key: string]: unknown;
}

export interface SupplyChainReport {
  check: string;
  checksRun: string[];
  findings: { category: string; target: string; finding: string }[];
  summary: string;
  passed: boolean;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function sourceDigest(report: SupplyChainReport): string {
  const stable = {
    check: report.check,
    checksRun: [...report.checksRun].sort(),
    findings: [...report.findings].sort((a, b) =>
      `${a.category}:${a.target}:${a.finding}`.localeCompare(`${b.category}:${b.target}:${b.finding}`),
    ),
    summary: report.summary,
    passed: report.passed,
  };
  return `sha256:${createHash('sha256').update(canonical(stable)).digest('hex')}`;
}
