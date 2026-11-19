# Development Conventions

## Runtime

Use `bun` instead of node/npm:
- `bun <file>` (instead of node)
- `bun test` (instead of jest)
- `bun build` (instead of webpack)

## Builtin APIs

Prefer Bun built-ins:
- `bun:sqlite` (not better-sqlite3)
- `Bun.spawn()` (for subprocess execution)
- `Bun.file()` (over fs.readFile)
- `Bun.write()` (over fs.writeFile)

## .env

Bun auto-loads `.env` — no dotenv package needed.

## Shell Scripts

Bridge scripts must:
- Use `#!/usr/bin/env bash` shebang
- Use `set -euo pipefail`
- Be executable (`chmod +x`)
- Follow the bridge protocol in `docs/BRIDGE_PROTOCOL.md`

## TypeScript Style

- ESM only (`import`/`export`, no `require`)
- Strict mode enabled
- No comments unless logic is non-obvious
