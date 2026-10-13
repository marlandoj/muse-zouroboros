#!/usr/bin/env bun
/**
 * defense.ts — Memory Defense: secret & PII scanning on the retain path
 *
 * Concept adopted from vectorize-io/hindsight's "Memory Defense"
 * (https://github.com/vectorize-io/hindsight): every memory write is scanned
 * before it reaches storage; matches are redacted (default) or blocked.
 *
 * Constitution alignment:
 *  - Article IX (Fail-Safe Defaults): the policy defaults to 'redact'; an
 *    unknown or malformed policy string falls back to 'redact', never 'off'.
 *  - Article VI (Provenance): redactions are recorded in fact metadata so the
 *    event stays auditable without the secret itself ever touching the DB.
 *
 * Policy resolution (env):
 *  - ZO_MEMORY_DEFENSE: 'redact' (default) | 'block' | 'off'
 *  - ZO_MEMORY_DEFENSE_PII: '1' opts PII patterns in (like hindsight's
 *    per-bank opt-in). Secrets are always enforced under redact/block; PII is
 *    opt-in because a memory system's job is remembering people — blanket
 *    email/phone redaction would destroy its utility.
 *
 * CLI:
 *   bun defense.ts scan --text "..."   Scan text, print findings (no storage)
 *   bun defense.ts patterns            List active patterns
 */

export type DefensePolicy = 'redact' | 'block' | 'off';
export type DefenseKind = 'secret' | 'pii';

export interface DefenseFinding {
  pattern: string;
  kind: DefenseKind;
  placeholder: string;
}

export interface DefenseResult {
  text: string;
  findings: DefenseFinding[];
  blocked: boolean;
}

interface DefensePattern {
  name: string;
  kind: DefenseKind;
  regex: RegExp;
  /** When set, only this capture group is replaced instead of the whole match. */
  redactGroup?: number;
}

// ---------------------------------------------------------------------------
// Pattern table (focused high-precision subset; hindsight ships ~45)
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: DefensePattern[] = [
  { name: 'aws_access_key_id', kind: 'secret', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'github_token', kind: 'secret', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g },
  { name: 'github_fine_grained_pat', kind: 'secret', regex: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { name: 'anthropic_api_key', kind: 'secret', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'openai_api_key', kind: 'secret', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'slack_token', kind: 'secret', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'google_api_key', kind: 'secret', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'stripe_key', kind: 'secret', regex: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  {
    name: 'private_key_block', kind: 'secret',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  { name: 'jwt', kind: 'secret', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g },
  {
    name: 'connection_string', kind: 'secret',
    regex: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/g,
  },
  {
    name: 'generic_secret_assignment', kind: 'secret',
    regex: /(\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*['"]?)([^\s'"]{8,})/gi,
    redactGroup: 2,
  },
];

const PII_PATTERNS: DefensePattern[] = [
  { name: 'us_ssn', kind: 'pii', regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: 'email_address', kind: 'pii', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // credit_card handled separately: candidate regex + Luhn verification
];

const CREDIT_CARD_CANDIDATE = /\b(?:\d[ -]?){13,19}\b/g;

// ---------------------------------------------------------------------------
// Policy resolution (fail-safe: anything unrecognized → redact)
// ---------------------------------------------------------------------------

export function resolveDefensePolicy(env: NodeJS.ProcessEnv = process.env): {
  policy: DefensePolicy;
  includePii: boolean;
} {
  const raw = (env.ZO_MEMORY_DEFENSE || 'redact').trim().toLowerCase();
  const policy: DefensePolicy = raw === 'off' ? 'off' : raw === 'block' ? 'block' : 'redact';
  return { policy, includePii: env.ZO_MEMORY_DEFENSE_PII === '1' };
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function placeholder(name: string): string {
  return `[REDACTED:${name}]`;
}

/**
 * Scan and transform text per policy. Under 'block' the text is returned
 * unchanged with blocked=true; under 'redact' matches are substituted with
 * [REDACTED:<pattern>] placeholders; under 'off' nothing is scanned.
 */
export function applyDefense(
  text: string,
  options: { policy?: DefensePolicy; includePii?: boolean } = {},
): DefenseResult {
  const resolved = resolveDefensePolicy();
  const policy = options.policy ?? resolved.policy;
  const includePii = options.includePii ?? resolved.includePii;

  if (policy === 'off' || !text) return { text, findings: [], blocked: false };

  const findings: DefenseFinding[] = [];
  const seen = new Set<string>();
  let out = text;

  const patterns: DefensePattern[] = includePii
    ? [...SECRET_PATTERNS, ...PII_PATTERNS]
    : SECRET_PATTERNS;

  for (const p of patterns) {
    // Test against `out` (not the original text) so a secret already redacted
    // by an earlier, more specific pattern isn't double-reported (e.g. an
    // Anthropic key must not also count as a generic OpenAI key).
    p.regex.lastIndex = 0;
    if (!p.regex.test(out)) continue;
    p.regex.lastIndex = 0;
    if (!seen.has(p.name)) { seen.add(p.name); findings.push({ pattern: p.name, kind: p.kind, placeholder: placeholder(p.name) }); }
    if (policy === 'redact') {
      if (p.redactGroup != null) {
        out = out.replace(p.regex, (...args) => {
          const groups = args.slice(1, -2) as string[];
          return String(groups[0]) + placeholder(p.name);
        });
      } else {
        out = out.replace(p.regex, placeholder(p.name));
      }
    }
  }

  // Credit cards: candidate regex + Luhn to keep false positives low
  if (includePii) {
    CREDIT_CARD_CANDIDATE.lastIndex = 0;
    const candidates = out.match(CREDIT_CARD_CANDIDATE) || [];
    const valid = candidates.filter(c => {
      const digits = c.replace(/[ -]/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
    });
    if (valid.length > 0) {
      findings.push({ pattern: 'credit_card', kind: 'pii', placeholder: placeholder('credit_card') });
      if (policy === 'redact') {
        for (const c of valid) out = out.split(c).join(placeholder('credit_card'));
      }
    }
  }

  return { text: policy === 'redact' ? out : text, findings, blocked: policy === 'block' && findings.length > 0 };
}

/** Raised by store paths when the block policy rejects a memory write. */
export class DefenseBlockedError extends Error {
  public readonly findings: DefenseFinding[];
  constructor(findings: DefenseFinding[]) {
    super(`Memory Defense blocked write: matched ${findings.map(f => f.pattern).join(', ')}`);
    this.name = 'DefenseBlockedError';
    this.findings = findings;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[i + 1] || '';
  const command = args[0];

  if (command === 'scan') {
    const text = flags.text;
    if (!text) { console.error('Usage: defense.ts scan --text "..."'); process.exit(1); }
    const result = applyDefense(text, { includePii: flags.pii === '1' });
    if (result.findings.length === 0) { console.log('No findings.'); process.exit(0); }
    console.log(`${result.findings.length} finding(s):`);
    for (const f of result.findings) console.log(`  [${f.kind}] ${f.pattern} → ${f.placeholder}`);
    console.log('\nTransformed text:\n' + result.text);
  } else if (command === 'patterns') {
    const { includePii } = resolveDefensePolicy();
    for (const p of SECRET_PATTERNS) console.log(`  [secret] ${p.name}`);
    if (includePii) for (const p of PII_PATTERNS) console.log(`  [pii] ${p.name}`);
    console.log('  [pii] credit_card (luhn-verified)');
    console.log(`\nPolicy: ${resolveDefensePolicy().policy} | PII: ${includePii ? 'on' : 'off'}`);
  } else {
    console.log('Memory Defense CLI\n\nCommands:\n  scan --text "..." [--pii 1]  Scan text, print findings\n  patterns                     List active patterns and policy');
  }
}

if (import.meta.main) main();
