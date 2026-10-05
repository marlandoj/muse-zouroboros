# Wayfinder workflows

```mermaid
flowchart LR
  A[Claude Code] --> H[Harness adapter]
  B[Codex CLI] --> H
  C[Kimi Code] --> H
  D[Gemini CLI] --> H
  E[OpenCode] --> H
  F[Pi] --> H
  G[Hermes] --> H
  H --> N[Normalize prompt]
  N --> Q[BM25 shortlist]
  S[Shared SKILL.md catalog] --> Q
  Q --> R[Local FlashRank reranking]
  R --> M{Mode}
  M -->|Shadow default| L[Private suggestion log]
  M -->|Live| I[One advisory context note]
  I --> J[Agent decides whether to read skill]
  R -->|Error or timeout| P[Continue without suggestion]
```

```mermaid
flowchart LR
  S[Install in shadow] --> R[Review actual suggestions]
  R --> D[Improve skill descriptions]
  D --> R
  R --> L[Enable live for one harness]
  L --> V[Verify note reaches agent]
  V --> A[Expand to other harnesses]
  A --> O[Monitor or switch back to shadow]
```

Setup may download the ranking model. Prompt-time ranking cannot download it. Live context is consumed by the harness and its configured provider; Wayfinder itself makes no remote ranking request.
