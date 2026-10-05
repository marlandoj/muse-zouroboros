# Contributing

Welcome — this project is better with more eyes on it. Here's how to help.

## The ethos, in one paragraph

This is infrastructure that runs on people's machines with their credentials.
Every change should make the system more trustworthy, not just more capable:
graceful degradation over hard failures, observation before enforcement, and
no new dependencies on outside platforms. If your change adds a network call,
a credential, or a new way to block someone's work, say so loudly in the PR
description.

## Filing issues

- **Bugs:** what you did, what you expected, what happened instead. The
  output of `scripts/verify.sh` is always helpful.
- **Ideas:** describe the problem first, then the proposal. "The swarm keeps
  picking the slow executor when…" beats "add a new flag".
- **Security issues:** don't file publicly — see SECURITY.md.

## Pull requests

- Keep PRs small and focused. One change, one reason.
- Update the docs if behavior changes. The walkthrough is a promise to
  novices — if your change invalidates a step, fix the step.
- Add or update tests where they exist (the swarm and factory lane both
  ship suites; run them with `bun test` in the package).
- Hook changes (wayfinder, verity, sift) must preserve shadow mode as the
  default and the fail-open guarantee: a crashing hook answers `{}` and the
  agent carries on. No exceptions.
- No new platform dependencies. The de-Zo port removed the last of them;
  keep it that way. If a component can't work without an outside service,
  it needs to degrade gracefully without it.
- Follow the existing code style in the file you're touching.

## What we're not looking for right now

- A second scheduler, a second notifications system, or a second personal
  memory. The architecture doc explains why — duplicates are maintenance
  paid twice.
- The Command Center web UI. It was deliberately left out of this package;
  see the README's honest notes.

## License

By contributing, you agree your work goes out under the repo's MIT license.
