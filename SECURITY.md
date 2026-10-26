# Security Policy

## Reporting a vulnerability

If you find a security issue in this repo, please don't file a public issue.
Use GitHub's private vulnerability reporting: go to the repository's
**Security** tab and choose **Report a vulnerability**. That opens a private
channel where we can discuss the fix before anything is disclosed.

Please include:

- What you found and where (file and, if you can, the line or section)
- What an attacker could do with it, in plain terms
- How to reproduce it, if that's safe to describe

## What we promise

- We'll acknowledge your report within a few days.
- We'll keep you updated as we work on a fix.
- We'll credit you in the release notes unless you'd rather stay anonymous.

## Scope

This project is security-sensitive by nature: it handles API keys, runs code
agents on your machine, and reviews your code. Reports we're especially
grateful for:

- Anything that could leak an API key, token, or credential — through logs,
  error messages or the Muse bridge
- Hooks behaving differently than documented (blocking when they should only
  observe, sending data off the machine, running with more privilege than
  needed)
- The factory executing work outside its stated authority or failing open
  where it promises to fail closed

Out of scope: the security of the model providers and AI CLIs themselves
(OpenAI, Anthropic, Claude Code, Codex, and so on) — report those to the
relevant vendor.

## Executor trust model

The swarm runs AI coding CLIs (executors) as ordinary processes under the
account that started the orchestrator, most of them with their tools
auto-approved. By default there is no operating-system isolation between an
executor and that account:

- An executor runs with the invoking user's privileges. It can read and write
  anything that user can, run commands, and reach the network.
- It can see that user's credentials and environment: environment variables,
  key files the user can read, and the credential stores of every installed
  CLI, not only its own.
- Task content can come from other models: upstream task output, recalled
  memory, files in the workspace. The orchestrator passes upstream output to
  later tasks as fenced data rather than as instructions. That reduces prompt
  injection; it is not a security boundary. An executor that follows injected
  text still acts with your full privileges.

For anything sensitive:

- Run the workshop under a dedicated OS user that holds only what the swarm
  needs, or inside a VM you can rebuild.
- Give that user scoped API keys: separate keys for the swarm, with spending
  limits and the narrowest permissions your providers offer. Don't reuse
  personal or production keys.
- Keep production credentials, SSH keys and cloud admin tokens out of that
  account.

## Key hygiene reminder

Keys belong in a private file on your machine (mode 600), never in chat,
never in a commit, never in an issue report. If a secret ever touches a
transcript or a ticket, rotate it.
