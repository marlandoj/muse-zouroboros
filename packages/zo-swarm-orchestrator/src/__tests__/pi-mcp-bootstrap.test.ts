import { describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPiMcpConfig,
  buildPiPrompt,
  findMcpConfigPath,
} from '../executor/bridges/pi-mcp-bootstrap.js';

describe('Pi MCP bootstrap', () => {
  test('preserves every shared MCP server and adds authenticated Zo tools', () => {
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
      const config = buildPiMcpConfig(sourcePath, {
        ZO_API_KEY: 'test-token',
        ZO_CONVERSATION_ID: 'test-conversation',
      }) as {
        mcpServers: Record<string, {
          url?: string;
          headers?: Record<string, string>;
        }>;
      };
      expect(Object.keys(config.mcpServers)).toEqual([
        'codebase-memory',
        'qdrant-rag',
        'semantic-scholar',
        'zo-memory',
        'zo',
      ]);
      expect(config.mcpServers.zo.url).toContain('conversation_id=test-conversation');
      expect(config.mcpServers.zo.headers?.Authorization).toBe(
        'Bearer ${ZO_API_KEY}',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('warns and preserves shared servers and settings when Zo credentials are unavailable', () => {
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
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const env of [{}, { ZO_CLIENT_IDENTITY_TOKEN: '', ZO_API_KEY: ' ', ZO_MCP_API_KEY: '' }]) {
        expect(buildPiMcpConfig(sourcePath, env)).toEqual(shared);
      }
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0]?.[0]).toContain('Skipping optional Zo server');
    } finally {
      warn.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('uses the first nonblank credential without persisting its value', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-mcp-token-'));
    const sourcePath = join(directory, '.mcp.json');
    writeFileSync(sourcePath, JSON.stringify({ mcpServers: {} }));
    try {
      const keys = ['ZO_CLIENT_IDENTITY_TOKEN', 'ZO_API_KEY', 'ZO_MCP_API_KEY'];
      for (let index = 0; index < keys.length; index++) {
        const env = Object.fromEntries(keys.map((key, position) => [key, position < index ? ' ' : 'test-secret']));
        const serialized = JSON.stringify(buildPiMcpConfig(sourcePath, env));
        expect(serialized).toContain(`Bearer \${${keys[index]}}`);
        expect(serialized).not.toContain('test-secret');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('still rejects missing or malformed shared configuration without Zo credentials', () => {
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
