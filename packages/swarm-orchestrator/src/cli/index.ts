#!/usr/bin/env bun
/**
 * CLI for Zouroboros Swarm
 *
 * Usage: zouroboros-swarm <tasks.json> [options]
 */

import { parseArgs } from 'util';
import { existsSync, readFileSync } from 'fs';
import { resolveExecutorRegistryPath } from '../registry/loader.js';
import { SwarmOrchestrator } from '../orchestrator.js';
import { loadSwarmPlanGateConfig } from '../plan-gate-preflight.js';
import { RoleRegistry } from '../roles/registry.js';
import { seedPersonasToRegistry } from '../roles/persona-seeder.js';
import { verifyWiring, printWiringReport } from '../verification/verify-wiring.js';
import { runGapAudit, printGapAuditReport } from '../verification/gap-audit.js';
import { runT3Subcommand } from './t3-run.js';
import { validateTask, SchemaValidationError } from '../schemas/swarm-schemas.js';
import type { Task, SwarmConfig } from '../types.js';

function printHelp() {
  console.log(`
zouroboros-swarm — Multi-agent orchestration with circuit breakers and routing

USAGE:
  zouroboros-swarm <tasks.json> [options]
  zouroboros-swarm status
  zouroboros-swarm doctor
  zouroboros-swarm roles <subcommand>

COMMANDS:
  doctor                  Run swarm health check
  status                  Show swarm status
  verify                  Verify capability wiring (import graph + reachability)
  gap-audit               Run automated gap audit (reachability + data + cross-boundary)
  roles list              List all roles in the registry
  roles seed-personas     Import agency personas into the RoleRegistry
  roles get <id>          Get details for a specific role
  roles delete <id>       Delete a role from the registry
  roles count             Show total number of roles

OPTIONS:
  --mode, -m           DAG mode: streaming | waves (default: streaming)
  --concurrency, -c    Max concurrent tasks (default: 8)
  --timeout, -t        Task timeout in seconds (default: 600)
  --strategy, -s       Routing strategy: fast | reliable | balanced | explore (default: balanced)
  --plan-gate-mode     disabled | advisory | shadow | enforce
  --plan-gate-plan     Structured plan artifact path
  --plan-gate-receipt  Approval receipt path
  --plan-gate-ledger   Audit ledger path
  --notify             Notification on complete: none | sms | email (default: none)
  --overwrite          For seed-personas: overwrite existing roles (default: false)
  --strict             For verify/gap-audit: treat warnings as errors
  --json               For verify/gap-audit: output JSON instead of human-readable
  --help, -h           Show this help

EXAMPLES:
  zouroboros-swarm ./tasks.json
  zouroboros-swarm ./tasks.json --mode waves --concurrency 4
  zouroboros-swarm ./tasks.json --strategy fast --notify email
  zouroboros-swarm verify
  zouroboros-swarm verify --strict --json
  zouroboros-swarm gap-audit
  zouroboros-swarm roles seed-personas
  zouroboros-swarm roles list
  zouroboros-swarm doctor
`);
}

async function handleRoles(subcommand: string, args: string[], overwrite: boolean) {
  const registry = new RoleRegistry();

  switch (subcommand) {
    case 'list': {
      const roles = registry.list();
      if (roles.length === 0) {
        console.log('No roles in registry. Run `roles seed-personas` to import agency personas.');
        return;
      }
      console.log(`\n📋 Roles (${roles.length} total)\n`);
      console.log('  ID'.padEnd(36) + 'Executor'.padEnd(14) + 'Model'.padEnd(10) + 'Name');
      console.log('  ' + '─'.repeat(74));
      for (const role of roles) {
        console.log(
          `  ${role.id.padEnd(34)}${role.executorId.padEnd(14)}${(role.model || '—').padEnd(10)}${role.name}`
        );
      }
      break;
    }

    case 'seed-personas': {
      console.log('🌱 Seeding RoleRegistry with agency personas...\n');
      const result = seedPersonasToRegistry(registry, { overwrite });
      console.log(`  Added: ${result.added}`);
      console.log(`  Skipped: ${result.skipped}`);
      console.log(`  Total roles: ${registry.count()}`);
      if (result.added > 0) {
        console.log('\nNew roles:');
        for (const r of result.roles) {
          console.log(`  ${r.id} → ${r.executorId} (${r.name})`);
        }
      }
      break;
    }

    case 'get': {
      const id = args[0];
      if (!id) {
        console.error('Error: role ID required. Usage: roles get <id>');
        process.exit(1);
      }
      const role = registry.get(id);
      if (!role) {
        console.error(`Role not found: ${id}`);
        process.exit(1);
      }
      console.log(JSON.stringify(role, null, 2));
      break;
    }

    case 'delete': {
      const id = args[0];
      if (!id) {
        console.error('Error: role ID required. Usage: roles delete <id>');
        process.exit(1);
      }
      const deleted = registry.delete(id);
      console.log(deleted ? `Deleted role: ${id}` : `Role not found: ${id}`);
      break;
    }

    case 'count': {
      console.log(`Total roles: ${registry.count()}`);
      break;
    }

    default:
      console.error(`Unknown roles subcommand: ${subcommand}`);
      console.log('Available: list, seed-personas, get, delete, count');
      process.exit(1);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      mode: { type: 'string', short: 'm', default: 'streaming' },
      concurrency: { type: 'string', short: 'c', default: '8' },
      timeout: { type: 'string', short: 't', default: '600' },
      strategy: { type: 'string', short: 's', default: 'balanced' },
      'plan-gate-mode': { type: 'string' },
      'plan-gate-plan': { type: 'string' },
      'plan-gate-receipt': { type: 'string' },
      'plan-workspace-root': { type: 'string' },
      'plan-gate-ledger': { type: 'string' },
      notify: { type: 'string', default: 'none' },
      overwrite: { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const command = positionals[0];

  if (command === 'doctor') {
    console.log('🔍 Running swarm health check...');
    const registry = JSON.parse(
      readFileSync(resolveExecutorRegistryPath(), 'utf-8')
    );

    for (const executor of registry.executors) {
      if (executor.healthCheck) {
        process.stdout.write(`  ${executor.name}: `);
        try {
          const result = Bun.spawnSync(['bash', '-c', executor.healthCheck.command]);
          if (result.exitCode === 0) {
            console.log('✅');
          } else {
            console.log('❌ (not installed)');
          }
        } catch {
          console.log('❌ (check failed)');
        }
      }
    }
    process.exit(0);
  }

  if (command === 'verify') {
    const report = verifyWiring({ strict: values.strict as boolean });
    if (values.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printWiringReport(report);
    }
    process.exit(report.passed ? 0 : 1);
  }

  if (command === 'gap-audit') {
    const report = runGapAudit({ fix: false });
    if (values.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printGapAuditReport(report);
    }
    process.exit(report.passed ? 0 : 1);
  }

  if (command === 'roles') {
    const subcommand = positionals[1];
    if (!subcommand) {
      console.error('Error: roles subcommand required. Usage: roles <list|seed-personas|get|delete|count>');
      process.exit(1);
    }
    await handleRoles(subcommand, positionals.slice(2), values.overwrite as boolean);
    process.exit(0);
  }

  if (command === 'status') {
    console.log('📊 Swarm Status');
    console.log('   Use --help for available commands');
    process.exit(0);
  }

  if (command === 't3-run') {
    // The t3-run subcommand owns its own flag parser (parseT3RunArgs), so
    // forward the raw args that follow the command token verbatim rather than
    // relying on the outer parseArgs result.
    const rawArgs = Bun.argv.slice(2);
    const idx = rawArgs.indexOf('t3-run');
    const t3Args = idx >= 0 ? rawArgs.slice(idx + 1) : [];
    const exitCode = await runT3Subcommand(t3Args);
    process.exit(exitCode);
  }

  // Load tasks
  const tasksPath = command;
  if (!tasksPath) {
    console.error('Error: No tasks file specified');
    printHelp();
    process.exit(1);
  }

  if (!existsSync(tasksPath)) {
    console.error(`Error: Tasks file not found: ${tasksPath}`);
    process.exit(1);
  }

  let tasks: Task[];
  try {
    const rawTasks = JSON.parse(readFileSync(tasksPath, 'utf-8'));
    if (!Array.isArray(rawTasks)) {
      throw new Error('Tasks file must contain an array');
    }
    tasks = rawTasks.map((rawTask: any) => {
      try {
        return validateTask(rawTask);
      } catch (err: any) {
        throw new Error(`Invalid task: ${err.message}`);
      }
    });
  } catch (err: any) {
    console.error(`Error parsing tasks file: ${err.message}`);
    process.exit(1);
  }

  // Build config
  const config: Partial<SwarmConfig> = {
    dagMode: values.mode as SwarmConfig['dagMode'],
    localConcurrency: parseInt(values.concurrency as string, 10),
    timeoutSeconds: parseInt(values.timeout as string, 10),
    routingStrategy: values.strategy as SwarmConfig['routingStrategy'],
    notifyOnComplete: values.notify as SwarmConfig['notifyOnComplete'],
    planGate: loadSwarmPlanGateConfig({
      mode: values['plan-gate-mode'] as string | undefined,
      planPath: values['plan-gate-plan'] as string | undefined,
      receiptPath: values['plan-gate-receipt'] as string | undefined,
      workspaceRoot: values['plan-workspace-root'] as string | undefined,
      ledgerPath: values['plan-gate-ledger'] as string | undefined,
    }),
  };

  // Run orchestrator
  const orchestrator = new SwarmOrchestrator(config);
  const results = await orchestrator.run(tasks);

  // Exit with error if any task failed
  const failedCount = results.filter(r => !r.success).length;
  process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
