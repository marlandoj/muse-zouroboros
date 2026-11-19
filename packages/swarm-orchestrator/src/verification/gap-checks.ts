/**
 * Gap-audit checks 4 and 5 (pure, dependency-free).
 *
 * The original audit covered three questions (reachability, data
 * prerequisites, cross-boundary state). The Agentic Patterns Enhancement
 * Plan (2026-10-02) §7 adds two more, run at every gate:
 *
 *   4. EVAL–PRODUCTION PARITY — does production use the same paths and
 *      capabilities as the benchmark/eval adapter? A capability whose only
 *      call sites live in bench/test harnesses inflates eval scores while
 *      production never invokes it (the local instance: t3-run invokes the
 *      consensus gate post-swarm; the orchestrator has no such caller).
 *   5. DANGLING IDENTIFIERS — after a delete or rename, does live config
 *      still point at the removed thing, and can a refactor grep collide?
 *      Duplicate exported symbols in different modules are the mechanical
 *      form of that risk (the plan's instance: two unrelated `runQualityGate`
 *      exports).
 *
 * These functions are pure so they can be unit-tested without the workspace
 * runtime; gap-audit.ts supplies the file reads.
 */

export interface CapabilityLike {
  id: string;
  edges: Array<{
    sourceModule: string;
    exports: string[];
    callSites: Array<{ file: string; pattern: string }>;
  }>;
}

export function isBenchOrTestPath(file: string): boolean {
  const f = file.replace(/\\/g, '/');
  return (
    f.includes('.test.') ||
    f.includes('.spec.') ||
    f.includes('/__tests__/') ||
    f.includes('cli/t3-run') ||
    f.includes('/bench') ||
    f.startsWith('bench') ||
    f.includes('bench-') ||
    f.startsWith('scripts/')
  );
}

/**
 * Flag capabilities with declared call sites that exist ONLY in bench/test
 * harnesses. Capabilities with no declared call sites are left to the
 * reachability check (check 1) — this check is specifically about the
 * eval-only wiring failure mode.
 */
export function detectEvalParityGaps(
  capabilities: CapabilityLike[],
  callSiteExists: (file: string, pattern: string) => boolean,
): Array<{ capabilityId: string; message: string; remediation: string }> {
  const gaps: Array<{ capabilityId: string; message: string; remediation: string }> = [];
  for (const cap of capabilities) {
    const sites = cap.edges.flatMap((e) => e.callSites);
    if (sites.length === 0) continue;
    const live = sites.filter((s) => callSiteExists(s.file, s.pattern));
    if (live.length === 0) continue; // missing call sites are check-1 failures
    if (live.every((s) => isBenchOrTestPath(s.file))) {
      gaps.push({
        capabilityId: cap.id,
        message: `[PARITY] Capability "${cap.id}" is only invoked from bench/test paths (${live.map((s) => s.file).join(', ')}) — production never calls it`,
        remediation: `Wire "${cap.id}" into a production caller (orchestrator/index) or explicitly retire it; do not let eval-only wiring stand in for production reachability`,
      });
    }
  }
  return gaps;
}

export interface SourceFileLike {
  path: string;
  content: string;
}

const EXPORT_RE = /export\s+(?:async\s+)?(?:function|const|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;

/**
 * Find symbols exported from more than one module. Same-name exports are a
 * rename/grep collision risk: a refactor can silently rewire a caller to the
 * wrong implementation.
 */
export function detectDuplicateExports(
  files: SourceFileLike[],
): Array<{ symbol: string; files: string[] }> {
  const bySymbol = new Map<string, Set<string>>();
  for (const f of files) {
    EXPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EXPORT_RE.exec(f.content)) !== null) {
      const set = bySymbol.get(m[1]) ?? new Set<string>();
      set.add(f.path);
      bySymbol.set(m[1], set);
    }
  }
  const out: Array<{ symbol: string; files: string[] }> = [];
  for (const [symbol, paths] of bySymbol) {
    if (paths.size > 1) out.push({ symbol, files: [...paths].sort() });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}
