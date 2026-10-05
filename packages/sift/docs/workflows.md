# Sift workflows

## Measure before promotion

```mermaid
flowchart LR
  A[Seven harnesses] --> B{Available interface}
  B -->|Command hook| C[Hash tool observations]
  B -->|Request history| D[Pair calls and results]
  D --> E[Protect text, failures and recent results]
  E --> F[Find duplicate reads and successful check output]
  F --> G{Configured mode}
  G -->|Shadow| H[Record counts and hashes]
  G -->|Live and supported| I[Archive exact output]
  I --> J[Verify checksum]
  J --> K[Replace output with recovery reference]
  J -->|Failure| L[Keep original request]
```

## Recover exact evidence

```mermaid
sequenceDiagram
  participant A as Coding agent
  participant S as Sift
  participant D as Private archive
  A->>S: Candidate history
  S->>D: Store output by SHA-256
  D-->>S: Verified original bytes
  S-->>A: Shorter result with path and checksum
  A->>D: Read original when needed
  Note over A,D: Original session storage remains unchanged
```

## An ambiguous result

Keep the result. If a person needs help evaluating it, explicitly submit a bounded excerpt to an authorized reviewer through the `review` command. Advice is not a deletion decision. Installed hooks never call the reviewer automatically.

## Harness support

Native request pruning: OpenCode, Pi, Hermes. Command observers: Claude Code, Codex, Kimi, Gemini. All can use explicit export against supported message layouts. Do not describe exported JSON as live native compaction.
