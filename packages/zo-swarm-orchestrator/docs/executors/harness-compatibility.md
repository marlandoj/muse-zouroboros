# Harness Compatibility Matrix

Generated from `executor-registry.json` and `harness-contract.json`. Do not edit manually.

Adapter inventory SHA-256: `2151387a27ff4f664ae1331334b1896199f6ab95ed4c445a4201084e7b320990`

| Harness | Transport | Instruction file | Read | Write | Shell | Web | MCP |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code | acp | CLAUDE.md | Read | Edit | Bash | unsupported | MCP |
| codex | acp | AGENTS.md | exec_command | apply_patch | exec_command | unsupported | MCP |
| gemini | acp | GEMINI.md | read_file | replace | run_shell_command | google_web_search | MCP |
| hermes | acp | AGENTS.md | read_file | write_file | terminal | web_search | MCP |
| kimi | acp | AGENTS.md | Read | Edit | Bash | unsupported | MCP |
| opencode | acp | AGENTS.md | read | edit | bash | webfetch | MCP |
| pi | bridge | AGENTS.md | read | edit | bash | unsupported | MCP |
