# Consensus panel: the reviewers

## What it is

Before the factory turns a finished build into a pull request, a small panel
of specialist personas reviews the work — the same way you'd ask two or three
senior engineers to look at a diff before it merges. The personas aren't
generic "AI reviewers." Each has a defined scope:

| Persona | Always seated? | Watches for |
|---|---|---|
| **Zouroboros Engineer** | Yes | Architecture, factory conventions, governance — did the build follow the system's own rules? |
| **Testing Reality Checker** | Yes | Verification honesty — do the tests actually prove what they claim? Would this survive production? |
| **AI Engineer** | When the ticket touches AI (models, prompts, agents, retrieval, evals) | Model limitations, eval soundness, failure modes of the AI parts |
| **Security Engineer** | When the ticket is high-risk or touches auth, credentials, privacy, secrets | Vulnerabilities, data exposure, abuse resistance |

This replaced an older model-quorum gate (retired — it measured model
diversity, which turned out to be a poor substitute for actual specialist
perspectives). The code lives in the factory lane (`factory/lane/scripts/`,
the `factory-diversity-review` and `factory-review-gate` modules).

## Shadow vs. enforce: the two modes

The panel runs in one of two modes, controlled by a single setting:

- **Shadow (the default).** The personas review, their verdicts are recorded,
  and nothing is blocked. A damning review becomes a note on the ticket, not
  a stopped build. You read the verdicts afterward and decide what to do.
- **Enforce.** The gate means it: a ticket advances to a pull request only
  if every required persona was actually invoked, every required verdict is
  a pass, and the reviewers ran on distinct models from diverse vendors.
  Anything less and the ticket is held.

The switch is the `FACTORY_REVIEW_GATE_MODE` environment variable, set to
`shadow` or `enforce`. Anything else is rejected outright. It defaults to
shadow, and shadow is where every new installation starts.

## What enforce does — and doesn't — do

Be precise about this, because it's the whole governance model:

- **Enforce can hold.** It can stop a ticket from advancing when the panel
  isn't satisfied. That's real power, and it's the point.
- **Enforce cannot approve.** A unanimous pass does not merge anything,
  deploy anything, or promote anything. Merges remain the operator's
  decision, always. The panel is a brake pedal, not an ignition key.
- **Enforce costs more.** It requires the reviewers to run on distinct
  models from diverse vendors — that's multi-vendor inference on every
  review, by design. Shadow mode has no such requirement.

## When to flip it: the qualification checklist

There is no automatic graduation. Flipping to enforce is an operator
decision, and it's only a responsible one when all of these are true:

1. **You've read the shadow verdicts.** Not skimmed — read. At least a
   dozen reviews, across different kinds of tickets.
2. **The panel agrees with your judgment.** When it passes work, you'd have
   passed it. When it holds work, you'd have held it — or it caught
   something you missed, and you can point to the case. A panel you
   routinely overrule hasn't earned enforcement.
3. **It has caught something real.** At least one hold where the panel
   found a genuine problem (a misclassified error, a test that proves
   nothing, a security hole). In the reference deployment, the panel's
   second-ever shadow verdict caught a real error misclassification — that
   kind of evidence is what you're looking for.
4. **You accept the cost.** Enforce mode means multi-vendor model calls on
   every review. Budget for it.
5. **You start narrow.** Flip it for one lane or one risk tier first, not
   everything at once. Watch a week of holds before widening.

If any of those aren't true yet, stay in shadow. Shadow mode isn't a
waiting room — it's a working mode. The verdicts are useful as advisory
input indefinitely; enforcement is optional, not the goal.

## Reading the verdicts

Every review writes a result file into the lane's state directory, under
the pool's `reviews/` folder. Each file records the mode, the terminal
state (`pass`, `pass_with_dissent`, `hold`, `shadow`, `no_review`), whether
the review blocked, the per-persona verdicts, and a summary in plain
language. The `scripts/panel-report.sh` script in this repo summarizes them
for you: how many reviews, how many would have held, and what the personas
said.

In shadow mode, pay special attention to `would-have-held` cases — those
are the reviews doing the most work, and they're your calibration data for
the checklist above.

## The honest state of things

The panel is young. Its track record is real but short, and the
harness-backed reviewer seats (personas running as full agent sessions
rather than scoped reviews) aren't built yet. Treat it as a promising
junior review board: worth listening to, worth grading, not yet worth
handing the merge button — which, per the governance rule above, it will
never get anyway.
