/**
 * Verify Wiring — mechanical import graph analysis + reachability checker.
 *
 * Reads the capability manifest, then for each declared edge:
 *   1. Confirms the source module exports the declared symbols
 *   2. Confirms each expected importer actually imports at least one symbol
 *   3. Confirms each call site pattern exists in the target file
 *
 * Also performs entry-point reachability: starting from known entry points
 * (orchestrator.ts, cli/index.ts, index.ts), walks imports and detects
 * orphaned modules (exported but never imported from any entry point path).
 *
 * Zero runtime dependencies — pure file reads + regex.
 * Runs in CI or via: bun verify-wiring.ts
 */

import { readFileSync, existsSync } from 'fs';
import { basename, join, dirname, resolve } from 'path';
import { CAPABILITY_MANIFEST, type Capability, type CapabilityEdge } from './capabilities.js';

const RUNTIME_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const PACKAGE_ROOT = resolve(RUNTIME_ROOT, '..');
const SOURCE_ROOTS = basename(RUNTIME_ROOT) === 'dist'
  ? [resolve(PACKAGE_ROOT, 'src'), RUNTIME_ROOT]
  : [RUNTIME_ROOT, resolve(PACKAGE_ROOT, 'dist')];

export type Severity = 'error' | 'warn' | 'info';

export interface WiringIssue {
  capabilityId: string;
  severity: Severity;
  type: 'missing_export' | 'missing_import' | 'missing_call_site' | 'file_not_found' | 'orphaned_module';
  message: string;
  file?: string;
  expected?: string;
}

export interface WiringReport {
  timestamp: number;
  totalCapabilities: number;
  totalEdges: number;
  issues: WiringIssue[];
  orphanedModules: string[];
  passed: boolean;
  summary: string;
}

function readSource(relativePath: string): string | null {
  const base = relativePath.replace(/\.(ts|js)$/, '');
  for (const root of SOURCE_ROOTS) {
    for (const candidate of [relativePath, `${base}.ts`, `${base}.js`, `${base}/index.ts`, `${base}/index.js`]) {
      const absPath = join(root, candidate);
      if (existsSync(absPath)) return readFileSync(absPath, 'utf-8');
    }
  }
  return null;
}

function sourceExists(relativePath: string): boolean {
  return readSource(relativePath) !== null;
}

function checkExports(edge: CapabilityEdge, capId: string): WiringIssue[] {
  const issues: WiringIssue[] = [];
  const source = readSource(edge.sourceModule);

  if (source === null) {
    issues.push({
      capabilityId: capId,
      severity: 'error',
      type: 'file_not_found',
      message: `Source module not found: ${edge.sourceModule}`,
      file: edge.sourceModule,
    });
    return issues;
  }

  for (const sym of edge.exports) {
    const exportPatterns = [
      new RegExp(`export\\s+(async\\s+)?(function|const|class|type|interface|enum)\\s+${sym}\\b`),
      new RegExp(`export\\s*\\{[^}]*\\b${sym}\\b[^}]*\\}`),
      new RegExp(`export\\s+default\\s+.*\\b${sym}\\b`),
    ];
    const found = exportPatterns.some(p => p.test(source));
    if (!found) {
      issues.push({
        capabilityId: capId,
        severity: 'error',
        type: 'missing_export',
        message: `Symbol "${sym}" not exported from ${edge.sourceModule}`,
        file: edge.sourceModule,
        expected: sym,
      });
    }
  }

  return issues;
}

function checkImporters(edge: CapabilityEdge, capId: string): WiringIssue[] {
  const issues: WiringIssue[] = [];

  for (const importer of edge.expectedImporters) {
    const source = readSource(importer);
    if (source === null) {
      issues.push({
        capabilityId: capId,
        severity: 'error',
        type: 'file_not_found',
        message: `Expected importer not found: ${importer}`,
        file: importer,
      });
      continue;
    }

    const moduleBase = edge.sourceModule.replace(/\.ts$/, '').replace(/\.js$/, '');
    const moduleName = moduleBase.replace(/^.*\//, '');
    // Match both `import ... from` and `export ... from` (re-exports)
    const importPatterns = [
      new RegExp(`from\\s+['"]\\.\\/${moduleBase}(\\.js)?['"]`),
      new RegExp(`from\\s+['"]\\.\\.\\/[^'"]*${moduleName}(\\.js)?['"]`),
      new RegExp(`from\\s+['"]\\./${moduleBase}(\\.js)?['"]`),
      new RegExp(`(?:import|export).*['"].*${moduleName}(\\.js)?['"]`),
      // Direct relative import from same directory: from './moduleName'
      new RegExp(`from\\s+['"]\\.\\/${moduleName}(\\.js)?['"]`),
    ];

    const found = importPatterns.some(p => p.test(source));
    if (!found) {
      issues.push({
        capabilityId: capId,
        severity: 'error',
        type: 'missing_import',
        message: `${importer} does not import from ${edge.sourceModule}`,
        file: importer,
        expected: edge.sourceModule,
      });
    }
  }

  return issues;
}

function checkCallSites(edge: CapabilityEdge, capId: string): WiringIssue[] {
  const issues: WiringIssue[] = [];

  for (const site of edge.callSites) {
    const source = readSource(site.file);
    if (source === null) {
      issues.push({
        capabilityId: capId,
        severity: 'error',
        type: 'file_not_found',
        message: `Call site file not found: ${site.file}`,
        file: site.file,
      });
      continue;
    }

    const regex = new RegExp(site.pattern);
    if (!regex.test(source)) {
      issues.push({
        capabilityId: capId,
        severity: 'error',
        type: 'missing_call_site',
        message: `Call site pattern "${site.pattern}" not found in ${site.file}`,
        file: site.file,
        expected: site.pattern,
      });
    }
  }

  return issues;
}

/**
 * Walk import graph from entry points and return set of reachable modules.
 */
function walkImportGraph(entryPoints: string[]): Set<string> {
  const visited = new Set<string>();
  const queue = [...entryPoints];

  while (queue.length > 0) {
    const current = queue.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const source = readSource(current);
    if (!source) continue;

    const importRegex = /from\s+['"](\.\.?\/[^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(source)) !== null) {
      let importPath = match[1];
      importPath = importPath.replace(/\.js$/, '.ts');

      const resolvedDir = dirname(current);
      let resolved = join(resolvedDir, importPath);
      if (!resolved.endsWith('.ts')) resolved += '.ts';

      // Normalize path separators
      resolved = resolved.replace(/\\/g, '/');
      // Remove leading ./ if present
      if (resolved.startsWith('./')) resolved = resolved.slice(2);

      if (sourceExists(resolved)) {
        queue.push(resolved);
      }
      // Try index.ts
      const indexPath = resolved.replace(/\.ts$/, '/index.ts');
      if (sourceExists(indexPath)) {
        queue.push(indexPath);
      }
    }
  }

  return visited;
}

/**
 * Detect orphaned modules: source modules declared in the manifest
 * but not reachable from any entry point.
 */
function detectOrphanedModules(reachable: Set<string>): WiringIssue[] {
  const issues: WiringIssue[] = [];
  const declaredModules = new Set<string>();

  for (const cap of CAPABILITY_MANIFEST) {
    for (const edge of cap.edges) {
      declaredModules.add(edge.sourceModule.replace(/\.js$/, '.ts'));
    }
  }

  for (const mod of declaredModules) {
    if (!reachable.has(mod)) {
      issues.push({
        capabilityId: 'reachability',
        severity: 'warn',
        type: 'orphaned_module',
        message: `Module "${mod}" is declared in manifest but not reachable from any entry point`,
        file: mod,
      });
    }
  }

  return issues;
}

/**
 * Run full wiring verification.
 *
 * @param options.strict If true, warnings also cause failure (default: false)
 */
export function verifyWiring(options: { strict?: boolean } = {}): WiringReport {
  const allIssues: WiringIssue[] = [];
  let totalEdges = 0;

  for (const cap of CAPABILITY_MANIFEST) {
    for (const edge of cap.edges) {
      totalEdges++;
      allIssues.push(...checkExports(edge, cap.id));
      allIssues.push(...checkImporters(edge, cap.id));
      allIssues.push(...checkCallSites(edge, cap.id));
    }
  }

  // Reachability analysis
  const entryPoints = ['index.ts', 'orchestrator.ts', 'cli/index.ts'];
  const reachable = walkImportGraph(entryPoints);
  const orphanIssues = detectOrphanedModules(reachable);
  allIssues.push(...orphanIssues);

  const orphanedModules = orphanIssues.map(i => i.file!);
  const errors = allIssues.filter(i => i.severity === 'error');
  const warnings = allIssues.filter(i => i.severity === 'warn');

  const passed = options.strict
    ? errors.length === 0 && warnings.length === 0
    : errors.length === 0;

  const summary = [
    `Capabilities: ${CAPABILITY_MANIFEST.length}`,
    `Edges: ${totalEdges}`,
    `Errors: ${errors.length}`,
    `Warnings: ${warnings.length}`,
    `Orphaned: ${orphanedModules.length}`,
    `Result: ${passed ? 'PASS' : 'FAIL'}`,
  ].join(' | ');

  return {
    timestamp: Date.now(),
    totalCapabilities: CAPABILITY_MANIFEST.length,
    totalEdges,
    issues: allIssues,
    orphanedModules,
    passed,
    summary,
  };
}

/**
 * Print a human-readable wiring report to stdout.
 */
export function printWiringReport(report: WiringReport): void {
  console.log('\n' + '='.repeat(70));
  console.log('WIRING VERIFICATION REPORT');
  console.log('='.repeat(70));
  console.log(`  ${report.summary}`);
  console.log('');

  if (report.issues.length === 0) {
    console.log('  All wiring checks passed.');
  } else {
    const grouped = new Map<string, WiringIssue[]>();
    for (const issue of report.issues) {
      const key = issue.capabilityId;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(issue);
    }

    for (const [capId, issues] of grouped) {
      const cap = CAPABILITY_MANIFEST.find(c => c.id === capId);
      const label = cap ? cap.name : capId;
      console.log(`  [${capId}] ${label}:`);
      for (const issue of issues) {
        const icon = issue.severity === 'error' ? '✗' : issue.severity === 'warn' ? '⚠' : 'ℹ';
        console.log(`    ${icon} ${issue.type}: ${issue.message}`);
      }
      console.log('');
    }
  }

  if (report.orphanedModules.length > 0) {
    console.log('  Orphaned modules (not reachable from entry points):');
    for (const mod of report.orphanedModules) {
      console.log(`    - ${mod}`);
    }
    console.log('');
  }

  console.log('='.repeat(70));
  console.log(`  ${report.passed ? '✅ PASS' : '❌ FAIL'}`);
  console.log('='.repeat(70));
}

// CLI entry point
if (import.meta.main) {
  const strict = process.argv.includes('--strict');
  const json = process.argv.includes('--json');

  const report = verifyWiring({ strict });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printWiringReport(report);
  }

  process.exit(report.passed ? 0 : 1);
}
