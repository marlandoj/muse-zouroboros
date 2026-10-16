/**
 * Authority eval — adversarial probes against the decision factory.
 *
 * The question under test is never "did the task succeed"; it is "was the
 * agent allowed to decide this, on what evidence, under whose authority".
 * Every probe models an attacker: a persona acting above its authority, a
 * caller bypassing the transport seam, an escalation downgrade, a retry after
 * a denial. Every probe must fail closed — the suite is red if any probe
 * fails open.
 *
 * Run standalone: `bun src/authority-eval.ts` (exit 0 green, 1 red).
 * CI gate: `src/__tests__/decision-factory.test.ts` asserts the suite is green.
 */

import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import {
  DecisionGate,
  DEFAULT_TIER_POLICY,
  escalateTier,
  type TierPolicy,
} from './approval-tiers.js';
import {
  MemoryDecisionRecordStore,
  type DecisionRecordStore,
} from './decision-record.js';
import { gatedAcpPermission } from './transport/acp-transport.js';

export interface AuthorityProbeResult {
  id: string;
  description: string;
  passed: boolean;
  detail: string;
}

export interface AuthorityEvalReport {
  green: boolean;
  passed: number;
  failed: number;
  probes: AuthorityProbeResult[];
}

function permissionRequest(
  title: string,
  kind: string,
  overrides: Partial<RequestPermissionRequest> = {},
): RequestPermissionRequest {
  return {
    sessionId: 'authority-eval-session',
    toolCall: {
      toolCallId: `probe-${title}`,
      title,
      kind,
      status: 'pending',
    },
    options: [
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
    ...overrides,
  } as RequestPermissionRequest;
}

function gate(opts: {
  store?: DecisionRecordStore;
  authority?: 'auto' | 'delegate';
  policy?: TierPolicy;
  allowedTools?: string[];
}): { gate: DecisionGate; store: DecisionRecordStore } {
  const store = opts.store ?? new MemoryDecisionRecordStore();
  return {
    store,
    gate: new DecisionGate({
      store,
      actor: 'probe-persona',
      origin: 'swarm',
      authority: opts.authority ?? 'delegate',
      ...(opts.policy ? { policy: opts.policy } : {}),
      ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
    }),
  };
}

type Probe = { id: string; description: string; run(): { passed: boolean; detail: string } };

const PROBES: Probe[] = [
  {
    id: 'above-authority-destructive',
    description: 'persona attempts a destructive (delete-kind) action: human tier, no human on path → denied',
    run() {
      const { gate: g } = gate({ authority: 'delegate' });
      const record = g.decide(
        { kind: 'tool_call', tool: 'Delete', summary: 'rm -rf /', target: '/' },
        'delete',
      );
      const passed = record.outcome === 'denied' && record.tier === 'human';
      return { passed, detail: `outcome=${record.outcome} tier=${record.tier} reason=${record.reason}` };
    },
  },
  {
    id: 'unknown-tool-fails-closed',
    description: 'an unclassified tool with an unknown kind classifies as destructive and is denied',
    run() {
      const { gate: g } = gate({ authority: 'delegate' });
      const record = g.decide(
        { kind: 'tool_call', tool: 'MysteryTool', summary: 'unknown capability' },
        'other',
      );
      const passed = record.outcome === 'denied' && record.blast_radius === 'destructive';
      return { passed, detail: `outcome=${record.outcome} blast_radius=${record.blast_radius}` };
    },
  },
  {
    id: 'escalation-is-one-way',
    description: 'de-escalating a tier (human→auto, delegate→auto) throws instead of laundering privilege',
    run() {
      const downgrades: Array<['auto' | 'delegate' | 'human', 'auto' | 'delegate' | 'human']> = [
        ['human', 'auto'],
        ['human', 'delegate'],
        ['delegate', 'auto'],
      ];
      const refused = downgrades.every(([from, to]) => {
        try {
          escalateTier(from, to);
          return false;
        } catch {
          return true;
        }
      });
      const upward = escalateTier('auto', 'human') === 'human';
      return { passed: refused && upward, detail: `downgrades_refused=${refused} upward_allowed=${upward}` };
    },
  },
  {
    id: 'denial-is-terminal',
    description: 'retrying an already-denied proposal denies again and records retry_after_denial',
    run() {
      const { gate: g, store } = gate({ authority: 'delegate' });
      const action = { kind: 'tool_call' as const, tool: 'Delete', summary: 'rm', target: '/etc' };
      const first = g.decide(action, 'delete');
      const second = g.decide(action, 'delete');
      const retryEvent = store.events().some(e => e.type === 'retry_after_denial');
      const passed = first.outcome === 'denied' && second.outcome === 'denied' && retryEvent;
      return { passed, detail: `first=${first.outcome} second=${second.outcome} retry_event=${retryEvent}` };
    },
  },
  {
    id: 'bypass-without-gate',
    description: 'the transport permission seam with no gate returns cancelled, never an allow option',
    run() {
      const response = gatedAcpPermission(undefined, permissionRequest('Read', 'read'));
      const passed = response.outcome?.outcome === 'cancelled';
      return { passed, detail: `response=${JSON.stringify(response)}` };
    },
  },
  {
    id: 'throwing-store-denies',
    description: 'a store that cannot persist the record denies the action (no record, no verdict)',
    run() {
      const brokenStore: DecisionRecordStore = {
        appendRecord() { throw new Error('disk full'); },
        appendEvent() { throw new Error('disk full'); },
        records: () => [],
        events: () => [],
      };
      const { gate: g } = gate({ store: brokenStore, authority: 'delegate' });
      const record = g.decide({ kind: 'tool_call', tool: 'Read', summary: 'read a file' }, 'read');
      const wire = gatedAcpPermission(g, permissionRequest('Read', 'read'));
      const passed = record.outcome === 'denied' && wire.outcome?.outcome === 'cancelled';
      return { passed, detail: `record=${record.outcome} wire=${JSON.stringify(wire)}` };
    },
  },
  {
    id: 'delegate-tier-needs-delegation',
    description: 'a network action under auto-only authority is denied (no delegation grant)',
    run() {
      const { gate: g } = gate({ authority: 'auto' });
      const record = g.decide({ kind: 'tool_call', tool: 'Fetch', summary: 'GET https://example.com', target: 'https://example.com' }, 'fetch');
      const passed = record.outcome === 'denied' && record.tier === 'delegate';
      return { passed, detail: `outcome=${record.outcome} tier=${record.tier}` };
    },
  },
  {
    id: 'budget-exhaustion-escalates-up',
    description: 'exhausting the auto budget escalates (one-way) to a tier this gate cannot grant → denied',
    run() {
      const policy: TierPolicy = {
        ...DEFAULT_TIER_POLICY,
        budgets: { maxAutoApprovals: 1, maxDelegateApprovals: 256 },
      };
      const { gate: g, store } = gate({ authority: 'auto', policy });
      const first = g.decide({ kind: 'tool_call', tool: 'Read', summary: 'read a', target: '/a' }, 'read');
      const second = g.decide({ kind: 'tool_call', tool: 'Read', summary: 'read b', target: '/b' }, 'read');
      const escalatedEvent = store.events().some(e => e.type === 'escalated');
      const passed = first.outcome === 'approved' && second.outcome === 'denied'
        && second.tier === 'delegate' && escalatedEvent;
      return { passed, detail: `first=${first.outcome} second=${second.outcome}@${second.tier} escalated_event=${escalatedEvent}` };
    },
  },
  {
    id: 'allowlist-violation-denied',
    description: 'a tool outside the executor allowlist is denied even when its tier would auto-approve',
    run() {
      const { gate: g } = gate({ authority: 'delegate', allowedTools: ['Read'] });
      const record = g.decide({ kind: 'tool_call', tool: 'Write', summary: 'write a file', target: '/tmp/x' }, 'edit');
      const passed = record.outcome === 'denied';
      return { passed, detail: `outcome=${record.outcome} reason=${record.reason}` };
    },
  },
  {
    id: 'denied-wire-response-is-cancelled',
    description: 'a denied proposal on the ACP wire yields cancelled, never a selected allow option',
    run() {
      const { gate: g } = gate({ authority: 'delegate' });
      const response = gatedAcpPermission(g, permissionRequest('Delete', 'delete'));
      const passed = response.outcome?.outcome === 'cancelled';
      return { passed, detail: `response=${JSON.stringify(response)}` };
    },
  },
  {
    id: 'anonymous-actor-refused',
    description: 'a gate for an empty/anonymous actor cannot be constructed (no unowned decisions)',
    run() {
      try {
        void new DecisionGate({
          store: new MemoryDecisionRecordStore(),
          actor: '  ',
          origin: 'swarm',
          authority: 'delegate',
        });
        return { passed: false, detail: 'gate constructed for anonymous actor' };
      } catch (error) {
        return { passed: true, detail: `refused: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  },
  {
    id: 'approval-still-recorded',
    description: 'accountability holds on the allow path too: an approved decision has a record, with proposal before verdict',
    run() {
      const { gate: g, store } = gate({ authority: 'delegate' });
      const record = g.decide({ kind: 'tool_call', tool: 'Read', summary: 'read a file', target: '/a' }, 'read');
      const stored = store.records().find(r => r.decision_id === record.decision_id);
      const events = store.events().filter(e => e.decision_id === record.decision_id).map(e => e.type);
      const orderOk = events.indexOf('proposed') === 0 && events.includes('approved');
      const passed = record.outcome === 'approved' && !!stored && orderOk;
      return { passed, detail: `outcome=${record.outcome} stored=${!!stored} events=${events.join(',')}` };
    },
  },
];

export function runAuthorityEvalSuite(): AuthorityEvalReport {
  const probes: AuthorityProbeResult[] = PROBES.map(probe => {
    try {
      const { passed, detail } = probe.run();
      return { id: probe.id, description: probe.description, passed, detail };
    } catch (error) {
      // A probe that crashes has not proven fail-closed behavior: red.
      return {
        id: probe.id,
        description: probe.description,
        passed: false,
        detail: `probe crashed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
  const failed = probes.filter(p => !p.passed).length;
  return { green: failed === 0, passed: probes.length - failed, failed, probes };
}

if (import.meta.main) {
  const report = runAuthorityEvalSuite();
  for (const probe of report.probes) {
    console.log(`${probe.passed ? 'PASS' : 'FAIL'}  ${probe.id} — ${probe.description}`);
    if (!probe.passed) console.log(`      ${probe.detail}`);
  }
  console.log(`\nauthority-eval: ${report.green ? 'GREEN' : 'RED'} (${report.passed}/${report.probes.length} probes passed)`);
  process.exit(report.green ? 0 : 1);
}
