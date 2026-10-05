import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { bridgeShimTargets, renderBridgeShim, syncBridgeShims } from '../../scripts/sync-bridge-shims.ts';
import { runDirectCli } from '../../../../Projects/zourobench-2026/hal-adapter/src/runners/claude-cli-direct.ts';

const root = resolve(import.meta.dir, '../../../..');
const bridges = join(root, 'packages/swarm/src/executor/bridges');
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'rb36 bridge '));
  temporary.push(directory);
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  // Do not load host credentials or PATH from the shared MCP environment file.
  // The bridge's caller environment is supplied explicitly by each fixture.
  const bashEnv = join(directory, 'bash-env');
  writeFileSync(bashEnv, `function .() {
  if [[ "$1" == /etc/zouroboros/zouroboros.env ]]; then return 0; fi
  builtin . "$@"
}
`);
  return { directory, bin, bashEnv };
}

function executable(path: string, source: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

async function invoke(path: string, args: string[], env: Record<string, string>, cwd: string) {
  const child = Bun.spawn(['bash', path, ...args], {
    cwd, env: { ZOUROBOROS_MODEL_CATALOG_PATH: join(cwd, 'no-native-catalog', 'current.json'), ...env, BASH_ENV: env.BASH_ENV ?? fixture().bashEnv },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

describe('canonical bridge compatibility paths', () => {
  test('checks every initialized legacy tree for generated shims', () => {
    expect(syncBridgeShims(root)).toEqual([]);
  });

  test('every shim preserves arguments, output, status, and caller cwd across paths with spaces', async () => {
    const { directory } = fixture();
    const args = ['literal prompt $(not-a-command)', 'directory with spaces'];
    for (const target of bridgeShimTargets) {
      executable(join(directory, target.path), renderBridgeShim(target));
      executable(join(directory, `packages/swarm/src/executor/bridges/${target.id}-bridge.sh`), `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$ARG_LOG"
pwd > "$CWD_LOG"
printf 'forwarded stdout'
printf 'forwarded stderr' >&2
exit 37
`);
      const result = await invoke(join(directory, target.path), args, {
        PATH: process.env.PATH!, ARG_LOG: join(directory, 'args'), CWD_LOG: join(directory, 'cwd'),
      }, tmpdir());
      expect(result).toEqual({ code: 37, stdout: 'forwarded stdout', stderr: 'forwarded stderr' });
      expect(readFileSync(join(directory, 'args'), 'utf8').trimEnd().split('\n')).toEqual(args);
      expect(readFileSync(join(directory, 'cwd'), 'utf8').trim()).toBe(tmpdir());
    }
  });

  test('reports a missing canonical bridge and detects handwritten shim drift', async () => {
    const { directory } = fixture();
    const target = bridgeShimTargets.at(-1)!;
    const path = join(directory, target.path);
    executable(path, renderBridgeShim(target));
    const result = await invoke(path, [], { PATH: process.env.PATH! }, directory);
    expect(result.code).toBe(127);
    expect(result.stderr).toContain('canonical claude-code bridge missing');
    expect(syncBridgeShims(directory)).toEqual([]);
    writeFileSync(path, '#!/bin/bash\necho drift\n');
    expect(syncBridgeShims(directory)).toEqual([`Bridge shim drift: ${target.path}`]);
    expect(syncBridgeShims(directory, false, true).some(message => message.includes('Uninitialized submodule'))).toBe(true);
  });
});

function fakeCli(id: 'claude-code' | 'codex' | 'gemini') {
  const data = fixture();
  const binary = join(data.bin, id === 'claude-code' ? 'claude' : id);
  executable(binary, `#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
pathlib.Path(os.environ['ARG_LOG']).write_text(json.dumps(args))
if '--output-last-message' in args:
    pathlib.Path(args[args.index('--output-last-message') + 1]).write_text('BRIDGE_OK')
elif '${id}' == 'claude-code':
    print(json.dumps({'result': 'BRIDGE_OK', 'usage': {'input_tokens': 13, 'output_tokens': 7}, 'total_cost_usd': 0.25, 'duration_ms': 12}))
else:
    print('BRIDGE_OK')
`);
  executable(join(data.bin, 'timeout'), '#!/usr/bin/env bash\nprintf "%s" "$1" > "$TIMEOUT_LOG"\nshift\nexec "$@"\n');
  const env = {
    PATH: `${data.bin}:${process.env.PATH}`, HOME: data.directory,
    ARG_LOG: join(data.directory, 'args.json'), TIMEOUT_LOG: join(data.directory, 'timeout'),
    RESULT_PATH: join(data.directory, 'result.json'), GEMINI_NO_DAEMON: '1',
    CLAUDE_CODE_BIN: binary, CODEX_BIN: binary,
    SWARM_MODEL_CATALOG_PATH: join(data.directory, 'absent-catalog.json'),
    BASH_ENV: data.bashEnv,
  };
  return { ...data, binary, env };
}

describe('bridge model contract', () => {
  for (const id of ['claude-code', 'codex', 'gemini'] as const) {
    for (const model of ['', 'swarm-heavy', 'moderate', `${id}-concrete-model`]) {
      test(`${id}: ${model || 'empty model'} keeps router ownership and timeout policy`, async () => {
        const data = fakeCli(id);
        const result = await invoke(join(bridges, `${id}-bridge.sh`), ['test prompt', data.directory], {
          ...data.env, SWARM_RESOLVED_MODEL: model, SWARM_TIER: 'complex',
        }, data.directory);
        expect(result.code).toBe(0);
        expect(result.stdout.trim()).toBe('BRIDGE_OK');
        const args = JSON.parse(readFileSync(data.env.ARG_LOG, 'utf8')) as string[];
        const index = args.indexOf(id === 'gemini' ? '-m' : '--model');
        const actual = index < 0 ? '' : args[index + 1];
        const tier = model === 'swarm-heavy' || model === 'moderate';
        const defaults = { 'claude-code': 'claude-opus-5', codex: '', gemini: 'gemini-3.8-flash' };
        const mid = { 'claude-code': 'claude-opus-5', codex: 'gpt-5.6-terra', gemini: 'gemini-3.8-flash' };
        const heavy = { 'claude-code': 'claude-fable-5-1', codex: 'gpt-6-astra', gemini: 'gemini-3.8-flash' };
        expect(actual).toBe(!model ? defaults[id] : tier ? (model === 'moderate' ? mid[id] : heavy[id]) : model);
        expect(result.stderr.includes('BRIDGE_WARN')).toBe(false);
        expect(readFileSync(data.env.TIMEOUT_LOG, 'utf8')).toBe('600');
        const structured = JSON.parse(readFileSync(data.env.RESULT_PATH, 'utf8'));
        expect(structured.status).toBe('success');
        if (id === 'claude-code') {
          expect(structured.metrics).toMatchObject({ inputTokens: 13, outputTokens: 7, tokensUsed: 20, totalCostUsd: 0.25 });
          expect(args).toContain('WebFetch');
          expect(args).toContain('WebSearch');
          expect(args).not.toContain('--yolo');
        }
      });
    }
  }

  test('Gemini native override guards tiers and strips the gc/ prefix', async () => {
    for (const model of ['light', 'complex', 'gc/gemini-explicit']) {
      const data = fakeCli('gemini');
      const result = await invoke(join(bridges, 'gemini-bridge.sh'), ['test', data.directory], { ...data.env, GEMINI_MODEL: model }, data.directory);
      expect(result.code).toBe(0);
      const args = JSON.parse(readFileSync(data.env.ARG_LOG, 'utf8')) as string[];
      expect(args[args.indexOf('-m') + 1]).toBe(model.startsWith('gc/') ? 'gemini-explicit' : model === 'light' ? 'gemini-3.5-flash-lite' : 'gemini-3.8-flash');
      expect(result.stderr.includes('BRIDGE_WARN')).toBe(false);
    }
  });

  test('HAL direct runner resolves the canonical bridge and receives its usage metrics', async () => {
    const data = fakeCli('claude-code');
    const original = { ...process.env };
    try {
      for (const [key, value] of Object.entries(data.env)) process.env[key] = value;
      const result = await runDirectCli('test prompt', 1, { workdir: data.directory, result_path: data.env.RESULT_PATH, model: 'claude-sonnet-4-6' });
      expect(result.exit_code).toBe(0);
      expect(result.cli_total_cost_usd).toBe(0.25);
      expect(result.rate_table_cost_usd).toBeGreaterThan(0);
    } finally {
      for (const key of Object.keys(data.env)) {
        if (original[key] === undefined) delete process.env[key];
        else process.env[key] = original[key];
      }
    }
  });
});

describe('preserved executor-specific behavior', () => {
  test('Kimi maps inherited provider credentials before starting ACP', async () => {
    const data = fixture();
    executable(join(data.bin, 'kimi'), `#!/usr/bin/env bash
[[ "$1" == acp ]] || exit 11
[[ "$KIMI_MODEL_API_KEY" == test-provider-key ]] || exit 12
[[ "$KIMI_MODEL_NAME" == moonshotai/kimi-qualified ]] || exit 13
printf 'INHERITED_OK'
`);
    const result = await invoke(join(bridges, 'kimi-bridge.sh'), ['--acp'], {
      PATH: `${data.bin}:${process.env.PATH}`, OPENROUTER_API_KEY: 'test-provider-key',
      SWARM_RESOLVED_MODEL: 'moonshotai/kimi-qualified', KIMI_MODEL_NAME: 'stale-default',
    }, data.directory);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('INHERITED_OK');
  });

  test('Pi keeps MCP configuration and concrete model forwarding without the stale approve flag', async () => {
    const data = fixture();
    const config = join(data.directory, 'mcp.json');
    const extension = join(data.directory, 'extension.ts');
    writeFileSync(config, '{"mcpServers":{}}');
    writeFileSync(extension, '');
    executable(join(data.bin, 'pi'), `#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
assert '--approve' not in args
config = json.loads(pathlib.Path(args[args.index('--mcp-config') + 1]).read_text())
assert 'zo' in config['mcpServers']
assert args[args.index('--model') + 1] == 'openrouter/moonshotai/kimi-k3'
print('PI_MCP_OK')
`);
    const result = await invoke(join(bridges, 'pi-bridge.sh'), ['test', data.directory], {
      PATH: `${data.bin}:${process.env.PATH}`, PI_MCP_CONFIG_PATH: config, PI_MCP_EXTENSION_PATH: extension,
      ZO_CLIENT_IDENTITY_TOKEN: 'test-token', MEMORY_GATE_URL: 'http://127.0.0.1:9',
      SWARM_RESOLVED_MODEL: 'openrouter/moonshotai/kimi-k3',
    }, data.directory);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('PI_MCP_OK');
  });

  test('Pi launches with local memory MCP servers when no Zo credentials are inherited', async () => {
    const data = fixture();
    const config = join(data.directory, 'mcp.json');
    const extension = join(data.directory, 'extension.ts');
    writeFileSync(config, JSON.stringify({ mcpServers: {
      'zo-memory': { command: 'bun', args: ['memory.ts'] },
      'qdrant-rag': { command: 'bun', args: ['rag.ts'] },
    } }));
    writeFileSync(extension, '');
    executable(join(data.bin, 'pi'), `#!/usr/bin/env python3
import json, pathlib, sys
args = sys.argv[1:]
config = json.loads(pathlib.Path(args[args.index('--mcp-config') + 1]).read_text())
assert set(config['mcpServers']) == {'zo-memory', 'qdrant-rag'}
print('PI_LOCAL_MCP_OK')
`);
    const result = await invoke(join(bridges, 'pi-bridge.sh'), ['test', data.directory], {
      PATH: `${data.bin}:${process.env.PATH}`, PI_MCP_CONFIG_PATH: config, PI_MCP_EXTENSION_PATH: extension,
      MEMORY_GATE_URL: 'http://127.0.0.1:9',
    }, data.directory);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('PI_LOCAL_MCP_OK');
    expect(result.stderr).toContain('Skipping optional Zo server');
  });

  test('Hermes retains the Anthropic subscription pin for provider-relative tiers', async () => {
    const data = fixture();
    const activate = join(data.directory, 'activate');
    writeFileSync(activate, '');
    executable(join(data.bin, 'hermes'), `#!/usr/bin/env python3
import sys
args = sys.argv[1:]
assert args[args.index('--provider') + 1] == 'anthropic'
assert args[args.index('--model') + 1] == 'claude-opus-5'
assert '-z' in args
print('HERMES_PIN_OK')
`);
    const result = await invoke(join(bridges, 'hermes-bridge.sh'), ['test', data.directory], {
      PATH: `${data.bin}:${process.env.PATH}`, HERMES_PROJECT_DIR: data.directory,
      HERMES_VENV: activate, HERMES_BIN: join(data.bin, 'hermes'), SWARM_RESOLVED_MODEL: 'mid',
      RESULT_PATH: join(data.directory, 'result.json'),
    }, data.directory);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('HERMES_PIN_OK');
  });
});
