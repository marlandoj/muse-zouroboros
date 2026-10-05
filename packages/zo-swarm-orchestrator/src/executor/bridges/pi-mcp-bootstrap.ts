import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

type JsonMcpServer = {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  type?: unknown;
  headers?: unknown;
};

export function findMcpConfigPath(configPath: string, workdir: string): string {
  if (isAbsolute(configPath)) return configPath;

  let directory = workdir;
  while (true) {
    const candidate = join(directory, configPath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return join(workdir, configPath);
    directory = parent;
  }
}

export function buildPiMcpConfig(
  sourcePath: string,
  env: Record<string, string | undefined> = process.env,
): Record<string, unknown> {
  if (!existsSync(sourcePath)) {
    throw new Error(`Pi MCP config does not exist: ${sourcePath}`);
  }
  const parsed = JSON.parse(readFileSync(sourcePath, 'utf8')) as {
    mcpServers?: Record<string, JsonMcpServer>;
    settings?: Record<string, unknown>;
  };
  const config = {
    settings: parsed.settings ?? {},
    mcpServers: { ...(parsed.mcpServers ?? {}) },
  };
  const tokenEnv = ['ZO_CLIENT_IDENTITY_TOKEN', 'ZO_API_KEY', 'ZO_MCP_API_KEY']
    .find(name => env[name]?.trim());
  if (!tokenEnv) {
    console.warn(
      '[Pi MCP] Skipping optional Zo server: no ZO_CLIENT_IDENTITY_TOKEN, ZO_API_KEY, or ZO_MCP_API_KEY is available',
    );
    return config;
  }
  const url = new URL(env.ZO_MCP_URL ?? 'https://api.zo.computer/mcp');
  const conversationId = env.ZO_CONVERSATION_ID ?? env.ZO_MCP_CONVERSATION_ID;
  if (conversationId && !url.searchParams.has('conversation_id')) {
    url.searchParams.set('conversation_id', conversationId);
  }

  return {
    settings: config.settings,
    mcpServers: {
      ...config.mcpServers,
      zo: {
        url: url.toString(),
        headers: {
          Authorization: `Bearer \${${tokenEnv}}`,
          'Content-Type': 'application/json',
        },
        lifecycle: 'lazy',
      },
    },
  };
}

export async function buildPiPrompt(
  prompt: string,
  persona: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  // Synthetic qualification must not attach private shared-memory briefings.
  if (env.SWARM_SYNTHETIC_CANARY === '1') return prompt;
  const baseUrl = (env.MEMORY_GATE_URL ?? 'http://localhost:7820').replace(/\/$/, '');
  const gateUrl = baseUrl.endsWith('/gate') ? baseUrl : `${baseUrl}/gate`;
  try {
    const response = await fetch(gateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'session context', persona }),
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return prompt;
    const context = (await response.text()).trim();
    if (!context || context === 'null') return prompt;
    return `${prompt}\n\n[SESSION BRIEFING - Zo Shared Memory]\n${context}`;
  } catch {
    return prompt;
  }
}

async function main(): Promise<void> {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'config') {
    const [workdir, outputPath] = args;
    if (!workdir || !outputPath) {
      throw new Error('Usage: pi-mcp-bootstrap.ts config <workdir> <output-path>');
    }
    const sourcePath = findMcpConfigPath(process.env.PI_MCP_CONFIG_PATH ?? '.mcp.json', workdir);
    writeFileSync(outputPath, `${JSON.stringify(buildPiMcpConfig(sourcePath), null, 2)}\n`, {
      mode: 0o600,
    });
    return;
  }
  if (mode === 'prompt') {
    const prompt = await Bun.stdin.text();
    process.stdout.write(await buildPiPrompt(prompt, process.env.SWARM_PERSONA ?? 'pi'));
    return;
  }
  throw new Error('Usage: pi-mcp-bootstrap.ts <config|prompt>');
}

if (import.meta.main) {
  await main();
}
