# P5 Judge-Calibration Set — Human Review

**Purpose:** Replace the AI-authored ground truth in `test-cases.json` with
human-verified labels. The consensus gate (and the ZOU-401 CI gate that depends
on it) can only be *proven* correct if the cases it's measured against are
*correct*. Right now the labels were written by me — that's the flaw this fixes.

**How to respond:** For each case, the proposed verdict is **PASS** (code is
acceptable) or **FAIL** (a judge *should* reject it). Just tell me which IDs to
flip. You don't need to touch the ones you agree with.

- **PASS** = the consensus gate should approve this change.
- **FAIL** = the consensus gate should block this change (real defect present).
- `expected_pass` in the JSON is `true` for PASS, `false` for FAIL.

---

## ⚠️ Needs your eye first (debatable or I'm flipping the AI label)

These are the calibration-critical cases. A miscalibrated *ground truth* here
poisons every judge metric, so please weigh in on these specifically.

| ID | Summary | AI label | **My proposed** | Why it's debatable |
|----|---------|----------|-----------------|--------------------|
| cal-013 | `quantities.reduce(+) * unitPrice` "overflow risk" | FAIL | **PASS (flip)** | JS numbers are float64; there is no integer overflow until 2^53. Flagging ordinary arithmetic as a defect is *over-strict*. Keeping this as FAIL trains judges to reject clean code. I recommend PASS. |
| cal-024 *(new)* | Correct but unidiomatic dedupe (manual loop, works) | — | **PASS** | Tests whether judges fail working code for *style*. Must be PASS or judges learn to conflate "ugly" with "broken." |
| cal-026 *(new)* | Hardcoded **non-secret** config (`const TIMEOUT_MS = 5000`) | — | **PASS** | Trap for the naive heuristic "hardcoded literal = bad." Not every constant is a leaked secret. Must be PASS. |
| cal-022 *(new)* | Loose equality `if (x == null)` for null-check | — | **PASS** | `== null` is the idiomatic null-OR-undefined check. A judge that FAILs this is over-strict. (Contrast with a genuine `==` bug — not this.) |
| cal-011 | XSS via HTML template interpolation | FAIL | **FAIL (keep)** | Correct *if* the string is rendered as HTML. Edge: if it's only logged/escaped downstream it's fine. I keep FAIL but flag the context-dependence. |
| cal-014 | Non-atomic balance check-then-update | FAIL | **FAIL (keep)** | Genuinely racy. Keeping FAIL. Listed here only because it's "hard" — judges often miss it, which is the point. |

---

## Full proposed set (28 cases)

Cases cal-001 … cal-020 are the existing ones (code in `test-cases.json`).
Cases cal-021 … cal-028 are **new** — code shown below the table.

| ID | Summary | Criteria | **Verdict** | Diff | Conf |
|----|---------|----------|-------------|------|------|
| cal-001 | SQL injection via template string | security | **FAIL** | keep | high |
| cal-002 | try/catch fetch wrapper, rethrows | correctness | **PASS** | keep | high |
| cal-003 | Hardcoded `sk_live_` Stripe key | security | **FAIL** | keep | high |
| cal-004 | O(n²) dup-find with `includes` inside | perf | **FAIL** | keep | med |
| cal-005 | `useMemo` with correct deps | correctness | **PASS** | keep | high |
| cal-006 | Endpoint with no authz check | security | **FAIL** | keep | high |
| cal-007 | Email/name input validation | correctness | **PASS** | keep | high |
| cal-008 | `await create` in a for-loop (N+1) | perf | **FAIL** | keep | med |
| cal-009 | `eval(expr)` | security | **FAIL** | keep | high |
| cal-010 | Async error-boundary middleware | correctness | **PASS** | keep | high |
| cal-011 | XSS HTML interpolation | security | **FAIL** | keep* | med |
| cal-012 | TS `config is Config` type guard | correctness | **PASS** | keep | high |
| cal-013 | Arithmetic "overflow" | correctness | **PASS** | **FLIP** | med |
| cal-014 | Non-atomic fund transfer | security | **FAIL** | keep | high |
| cal-015 | Redis cache-aside | perf | **PASS** | keep | high |
| cal-016 | Path traversal in `readFileSync` | security | **FAIL** | keep | high |
| cal-017 | Unbounded `findMany()` (no pagination) | perf | **FAIL** | keep | med |
| cal-018 | `Promise.all` parallel fetch | perf | **PASS** | keep | high |
| cal-019 | Empty `catch {}` swallows errors | correctness | **FAIL** | keep | high |
| cal-020 | Password logged in plaintext | security | **FAIL** | keep | high |
| cal-021 | **Parameterized** SQL query | security | **PASS** | new | high |
| cal-022 | `== null` null-check | correctness | **PASS** | new | high |
| cal-023 | `Math.random()` for a security token | security | **FAIL** | new | high |
| cal-024 | Unidiomatic-but-correct dedupe | correctness | **PASS** | new | high |
| cal-025 | Floating (unawaited) promise | correctness | **FAIL** | new | med |
| cal-026 | Hardcoded non-secret constant | security | **PASS** | new | high |
| cal-027 | Off-by-one: `<=` past array end | correctness | **FAIL** | new | high |
| cal-028 | Secret read from `process.env` | security | **PASS** | new | high |

\* keep, but context-dependent — see "needs your eye."

**Balance:** 14 FAIL / 14 PASS. Category spread: security 12, correctness 11,
perf 4 (1 case is dual). That balance matters — an all-FAIL set can't measure a
judge's false-fail (over-strict) rate, and an all-PASS set can't measure
false-pass (lenient) rate. The new positive controls (cal-021/026/028) and traps
(cal-022/024) exist specifically to catch *over-strict* judges, which the
original 20 (skewed 13 FAIL / 7 PASS) could barely measure.

---

## New case code (cal-021 … cal-028)

### cal-021 — Parameterized SQL query → **PASS** (security)
Positive control for cal-001. Same shape, done right.
```ts
const rows = await db.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
```

### cal-022 — `== null` null-check → **PASS** (correctness)
Idiomatic null-OR-undefined guard. Over-strict judges may flag `==`.
```ts
function firstName(user?: { name?: string }) {
  if (user == null || user.name == null) return 'Guest';
  return user.name.split(' ')[0];
}
```

### cal-023 — `Math.random()` for a security token → **FAIL** (security)
Not cryptographically secure; predictable session/reset tokens.
```ts
function makeResetToken(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
```

### cal-024 — Unidiomatic but correct dedupe → **PASS** (correctness)
Works correctly. A judge that FAILs this is penalizing style, not defects.
```ts
function unique(items: number[]): number[] {
  const out: number[] = [];
  for (const x of items) {
    let seen = false;
    for (const y of out) if (y === x) seen = true;
    if (!seen) out.push(x);
  }
  return out;
}
```

### cal-025 — Floating (unawaited) promise → **FAIL** (correctness)
`sendEmail` rejection is unhandled; the await on the next line doesn't cover it.
```ts
async function register(user: User) {
  sendWelcomeEmail(user.email);           // not awaited, errors vanish
  await db.users.create({ data: user });
}
```

### cal-026 — Hardcoded non-secret constant → **PASS** (security)
A timeout constant is not a leaked credential. Trap for "hardcoded = bad."
```ts
const REQUEST_TIMEOUT_MS = 5000;
export function withTimeout<T>(p: Promise<T>) {
  return Promise.race([p, sleep(REQUEST_TIMEOUT_MS).then(() => { throw new Error('timeout'); })]);
}
```

### cal-027 — Off-by-one past array end → **FAIL** (correctness)
`<=` reads `arr[arr.length]` → `undefined`, NaN sum.
```ts
function sum(arr: number[]): number {
  let total = 0;
  for (let i = 0; i <= arr.length; i++) total += arr[i];
  return total;
}
```

### cal-028 — Secret from `process.env` → **PASS** (security)
Positive control for cal-003. Secret is injected, not embedded.
```ts
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_KEY) throw new Error('STRIPE_SECRET_KEY not set');
export const stripe = new Stripe(STRIPE_KEY);
```

---

## After you approve

1. I apply your flips to a new `test-cases.json` (v2, dated, human-verified).
2. Run P5 **live** (real consensus gate, not `--mock`) against the 28 cases.
3. Report per-judge accuracy / leniency / strictness + any calibration
   recommendations. *That* is when judge-calibration moves from Low→High
   confidence and ZOU-401's gate becomes trustworthy.
