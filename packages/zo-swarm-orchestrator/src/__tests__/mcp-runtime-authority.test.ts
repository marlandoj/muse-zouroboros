import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(import.meta.dir, '../../../..');
const roots: string[] = [];
const campaigns: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
  for (const id of campaigns.splice(0)) rmSync(`/tmp/swarm-tasks-${id}.json`, { force: true });
});

for (const entrypoint of ['packages/swarm/scripts/mcp-server.ts', 'packages/swarm/src/standalone/mcp-server.ts']) {
  test(`${entrypoint} launches the canonical runtime with its actual CLI and result paths`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'rb2-mcp-'));
    roots.push(home);
    mkdirSync(join(home, 'bin'));
    mkdirSync(join(home, '.swarm/results'), { recursive: true });
    const id = `rb2-mcp-${process.pid}-${Date.now()}`;
    campaigns.push(id);
    // Replace only the MCP server's outbound campaign process. The server itself
    // runs under the real Bun binary; this fixture cannot invoke models/sentinels.
    const fake = join(home, 'bin/bun');
    writeFileSync(fake, `#!/bin/bash
printf '%s\\n' "$@" > "$HOME/args"
printf '%s' "$ZO_TRACE_ID" > "$HOME/trace"
cp "$HOME/result-fixture.json" "$HOME/.swarm/results/$FIXTURE_CAMPAIGN.json"
`);
    chmodSync(fake, 0o755);
    writeFileSync(join(home, 'result-fixture.json'), JSON.stringify({ swarmId: id, results: [{ success: true }] }));
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, entrypoint)],
      env: { ...env, HOME: home, PATH: `${home}/bin:${process.env.PATH}`, ZO_TRACE_ID: id, FIXTURE_CAMPAIGN: id },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'rb2-fixture', version: '1.0.0' });
    try {
      await client.connect(transport);
      const response = await client.callTool({ name: 'swarm_execute', arguments: {
        tasks: [{ task: 'Fixture only' }], campaignName: id, localConcurrency: 3, waitForCompletion: true,
      } });
      expect(response.isError).not.toBe(true);
      expect(JSON.stringify(response.content)).toContain('Success: 1/1 tasks');
      expect(readFileSync(join(home, 'args'), 'utf8').trim().split('\n')).toEqual([
        'run', join(root, 'packages/swarm/scripts/orchestrate-v5.ts'), `/tmp/swarm-tasks-${id}.json`,
        '--swarm-id', id, '--concurrency', '3', '--swarm-events',
      ]);
      expect(readFileSync(join(home, 'trace'), 'utf8')).toBe(id);
      const status = await client.callTool({ name: 'swarm_status', arguments: { swarmId: id } });
      expect(JSON.stringify(status.content)).toContain(id);
      expect(JSON.stringify(status.content)).not.toContain('not found');
    } finally { await client.close(); }
  }, 15_000);
}
