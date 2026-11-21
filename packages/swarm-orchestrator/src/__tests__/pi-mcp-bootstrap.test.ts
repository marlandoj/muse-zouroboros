import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPiMcpConfig,
  buildPiPrompt,
  findMcpConfigPath,
} from '../executor/bridges/pi-mcp-bootstrap.js';

describe('Pi MCP bootstrap', () => {
  test('preserves every shared MCP server and never injects a Zo server', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-mcp-'));
    const nested = join(directory, 'packages', 'swarm');
    mkdirSync(nested, { recursive: true });
    const sourcePath = join(directory, '.mcp.json');
    writeFileSync(sourcePath, JSON.stringify({
      mcpServers: {
        'codebase-memory': { command: 'codebase-memory-mcp' },
        'qdrant-rag': { command: 'bun', args: ['qdrant-rag-mcp.ts'] },
        'semantic-scholar': { command: 'uvx', args: ['semantic-scholar-fastmcp'] },
        'zo-memory': { command: 'bun', args: ['mcp-server.ts'] },
      },
    }));
    try {
      expect(findMcpConfigPath('.mcp.json', nested)).toBe(sourcePath);
      // The Zo MCP server injection was removed outright (governance review
      // 2026-10-14): even with Zo tokens present, no `zo` server is added and
      // no credential is ever serialized toward the retired platform.
      for (const env of [
        {},
        { ZO_API_KEY: 'test-token', ZO_CONVERSATION_ID: 'test-conversation' },
        { ZO_CLIENT_IDENTITY_TOKEN: 'tok', ZO_MCP_API_KEY: 'tok2' },
      ]) {
        const config = buildPiMcpConfig(sourcePath, env) as {
          mcpServers: Record<string, unknown>;
        };
        expect(Object.keys(config.mcpServers)).toEqual([
          'codebase-memory',
          'qdrant-rag',
          'semantic-scholar',
          'zo-memory',
        ]);
        expect(JSON.stringify(config)).not.toContain('api.zo.computer');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('preserves shared servers and settings byte-for-byte', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-mcp-auth-'));
    const sourcePath = join(directory, '.mcp.json');
    const shared = {
      settings: { toolPrefix: 'mcp' },
      mcpServers: {
        'zo-memory': { command: 'bun', args: ['memory.ts'] },
        'qdrant-rag': { command: 'bun', args: ['rag.ts'] },
        custom: { url: 'https://custom.test/mcp' },
      },
    };
    writeFileSync(sourcePath, JSON.stringify(shared));
    try {
      expect(buildPiMcpConfig(sourcePath, {})).toEqual(shared);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('still rejects missing or malformed shared configuration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-mcp-invalid-'));
    const sourcePath = join(directory, '.mcp.json');
    try {
      expect(() => buildPiMcpConfig(sourcePath, {})).toThrow('Pi MCP config does not exist');
      writeFileSync(sourcePath, '{invalid');
      expect(() => buildPiMcpConfig(sourcePath, {})).toThrow(SyntaxError);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('injects the memory-gate briefing into Pi prompts', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('Pi memory context.', {
      status: 200,
    })) as typeof fetch;
    try {
      const prompt = await buildPiPrompt(
        'Inspect the repository.',
        'pi',
        { MEMORY_GATE_URL: 'http://memory.test' },
      );
      expect(prompt).toContain('Inspect the repository.');
      expect(prompt).toContain('[SESSION BRIEFING - Zo Shared Memory]');
      expect(prompt).toContain('Pi memory context.');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
