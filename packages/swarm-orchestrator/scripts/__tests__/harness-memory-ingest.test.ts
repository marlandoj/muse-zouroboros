import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chunkBody,
  ingestHarnessMemory,
  loadEnvFile,
  parseFrontmatter,
  parseGeminiMemories,
  parseSource,
  redactSecrets,
  MAX_CHUNK_CHARS,
} from '../../../../scripts-vps/ingest-harness-memory';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'harness-memory-'));
  roots.push(root);
  const home = join(root, 'home');
  const claude = join(home, '.claude', 'projects', '-home-tester', 'memory');
  mkdirSync(claude, { recursive: true });
  writeFileSync(join(claude, 'MEMORY.md'), '- [Alpha](alpha.md) index line\n');
  writeFileSync(join(claude, 'alpha.md'), `---\nname: alpha-rule\ndescription: Deploys need a dry run first\nmetadata:\n  type: feedback\n---\n\nAlways dry-run deploys before applying. api_key: ${SECRET}\n`);
  writeFileSync(join(claude, 'beta.md'), '---\nname: beta-project\ndescription: Beta project status\nmetadata:\n  type: project\n---\n\nThe beta migration finished on 2026-09-01 and is verified.\n');
  writeFileSync(join(claude, 'probe.md'), 'probe');

  const hermes = join(home, '.hermes', 'memories');
  mkdirSync(hermes, { recursive: true });
  writeFileSync(join(hermes, 'MEMORY.md'), 'Hermes docs live at the nousresearch docs site.\n§\nThe VPS runs Hermes under the zouroboros user.');

  mkdirSync(join(home, '.codex'), { recursive: true });
  const codex = new Database(join(home, '.codex', 'memories_1.sqlite'));
  codex.run('CREATE TABLE stage1_outputs (thread_id TEXT PRIMARY KEY, source_updated_at INTEGER NOT NULL, raw_memory TEXT NOT NULL, rollout_summary TEXT NOT NULL, rollout_slug TEXT, generated_at INTEGER NOT NULL)');
  codex.run("INSERT INTO stage1_outputs VALUES ('thread-1', 1788000000, 'Codex learned that CI runs bun test for swarm scripts.', 'summary', 'ci-notes', 1788000000)");
  codex.close();

  mkdirSync(join(home, '.gemini'), { recursive: true });
  writeFileSync(join(home, '.gemini', 'GEMINI.md'), '# Project\n\n## Gemini Added Memories\n- The user prefers concise review comments\n- The user wants tests before merging\n\n## Other\n- not a memory at all, skip it\n');

  const dbPath = join(root, 'facts.db');
  const db = new Database(dbPath);
  db.run(`CREATE TABLE facts (id TEXT PRIMARY KEY, persona TEXT NOT NULL DEFAULT 'shared', entity TEXT NOT NULL, key TEXT, value TEXT NOT NULL, text TEXT,
    category TEXT DEFAULT 'fact', decay_class TEXT DEFAULT 'stable', importance REAL DEFAULT 1.0, source TEXT, created_at INTEGER NOT NULL,
    expires_at INTEGER, last_accessed INTEGER, confidence REAL DEFAULT 1.0, metadata TEXT)`);
  db.run('CREATE TABLE fact_embeddings (fact_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE, embedding BLOB NOT NULL, model TEXT, created_at INTEGER)');
  db.run('CREATE TABLE fact_provenance (id TEXT PRIMARY KEY, fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE, source TEXT NOT NULL, captured_at INTEGER NOT NULL, capture_method TEXT, UNIQUE(fact_id, source))');
  db.run("INSERT INTO facts (id, entity, value, text, source, created_at) VALUES ('unrelated', 'project.other', 'keep me', 'keep me', 'mcp', 1)");
  db.close();
  return { root, home, claude, hermes, dbPath };
}

function counter() {
  const calls: string[][] = [];
  const embed = async (texts: string[]) => { calls.push(texts); return texts.map(() => Array(1536).fill(0.01)); };
  return { calls, embed };
}

const harnessFacts = (dbPath: string) => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query("SELECT f.id, f.source, f.value, f.category, f.decay_class, f.expires_at, length(e.embedding) AS bytes FROM facts f LEFT JOIN fact_embeddings e ON e.fact_id = f.id WHERE f.source LIKE 'harness-memory:%' ORDER BY f.source").all() as any[];
  } finally { db.close(); }
};

describe('harness memory ingest helpers', () => {
  test('parses frontmatter including nested metadata type', () => {
    const { fields, body } = parseFrontmatter('---\nname: x\ndescription: "quoted"\nmetadata:\n  type: user\n---\n\nBody text\n');
    expect(fields).toMatchObject({ name: 'x', description: 'quoted', type: 'user' });
    expect(body).toBe('Body text');
    expect(parseFrontmatter('no frontmatter').body).toBe('no frontmatter');
  });

  test('redacts common secret shapes once each', () => {
    const { text, count } = redactSecrets(`api_key: ${SECRET}\nBearer abcdefghijklmnopqrstuvwxyz012345\npassword=hunter2hunter2`);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('hunter2hunter2');
    expect(text).toContain('Bearer [REDACTED]');
    expect(count).toBe(3);
    expect(redactSecrets('validation token baa6e566 is fine').count).toBe(0);
  });

  test('leaves env and code references to secrets intact', () => {
    for (const reference of [
      'const apiKey = process.env.LINEAR_API_KEY;',
      'token=${GITHUB_TOKEN}',
      'password: $DB_PASSWORD',
      "secret = os.environ['APP_SECRET']",
      'api_key: <your-api-key-here>',
    ]) {
      expect(redactSecrets(reference)).toEqual({ text: reference, count: 0 });
    }
    expect(redactSecrets('const apiKey = "abcd1234efgh5678";').text).toBe('const apiKey = [REDACTED];');
  });

  test('chunks long bodies at paragraph boundaries within the limit', () => {
    const paragraph = 'x'.repeat(MAX_CHUNK_CHARS - 100);
    const chunks = chunkBody([paragraph, paragraph, 'tail'].join('\n\n'));
    expect(chunks.length).toBe(2);
    expect(chunks.every((chunk) => chunk.length <= MAX_CHUNK_CHARS)).toBe(true);
    expect(chunkBody('y'.repeat(MAX_CHUNK_CHARS * 2 + 5)).length).toBe(3);
  });

  test('reads only the Gemini saved-memory section', () => {
    expect(parseGeminiMemories('## Gemini Added Memories\n- one\n* two\n## Next\n- three')).toEqual(['one', 'two']);
    expect(parseGeminiMemories('# nothing here')).toEqual([]);
  });

  test('parses harness sources and loads env files without overriding', () => {
    expect(parseSource('harness-memory:claude-code:-home-x/a.md#1')).toEqual({ harness: 'claude-code', store: '-home-x' });
    expect(parseSource('mcp')).toBeNull();
    const root = mkdtempSync(join(tmpdir(), 'harness-env-'));
    roots.push(root);
    writeFileSync(join(root, 'env'), '# comment\nexport A="1"\nB=two\nC=keep\n');
    const env: Record<string, string | undefined> = { C: 'existing' };
    loadEnvFile(join(root, 'env'), env);
    expect(env).toEqual({ A: '1', B: 'two', C: 'existing' });
  });
});

describe('harness memory ingest', () => {
  test('previews without writing, then applies, stays idempotent, updates in place and prunes safely', async () => {
    const { home, claude, hermes, dbPath } = fixture();
    const { calls, embed } = counter();

    const preview = await ingestHarnessMemory({ home, dbPath, embed });
    expect(preview).toMatchObject({ applied: false, facts: 7, inserted: 7, updated: 0, pruned: 0, skippedShort: 1, redactions: 1 });
    expect(preview.stores.map((s) => `${s.harness}:${s.store}:${s.readable}:${s.notes}`)).toEqual([
      'claude-code:-home-tester:true:3', 'hermes:memories:true:2', 'codex:memories_1:true:1', 'gemini:GEMINI.md:true:2',
    ]);
    expect(calls.length).toBe(0);
    expect(harnessFacts(dbPath)).toHaveLength(0);

    const applied = await ingestHarnessMemory({ home, dbPath, embed, apply: true });
    expect(applied).toMatchObject({ applied: true, inserted: 7, embedded: 7 });
    const rows = harnessFacts(dbPath);
    expect(rows).toHaveLength(7);
    expect(rows.every((row) => row.bytes === 1536 * 4 && row.expires_at === null)).toBe(true);
    expect(rows.some((row) => row.value.includes(SECRET))).toBe(false);
    expect(rows.some((row) => row.source.includes('MEMORY.md#') && row.source.startsWith('harness-memory:claude-code'))).toBe(false);
    const alpha = rows.find((row) => row.source === 'harness-memory:claude-code:-home-tester/alpha.md#1');
    expect(alpha).toMatchObject({ category: 'convention', decay_class: 'permanent' });
    expect(alpha.value).toStartWith('alpha-rule: Deploys need a dry run first');
    const db = new Database(dbPath, { readonly: true });
    expect((db.query("SELECT count(*) AS n FROM fact_provenance WHERE capture_method = 'harness-memory-ingest'").get() as any).n).toBe(7);
    db.close();

    const again = await ingestHarnessMemory({ home, dbPath, embed, apply: true });
    expect(again).toMatchObject({ unchanged: 7, inserted: 0, updated: 0, pruned: 0, embedded: 0 });

    writeFileSync(join(claude, 'beta.md'), '---\nname: beta-project\ndescription: Beta project status\nmetadata:\n  type: project\n---\n\nThe beta migration was rolled back on 2026-09-05.\n');
    const changed = await ingestHarnessMemory({ home, dbPath, embed, apply: true });
    expect(changed).toMatchObject({ updated: 1, inserted: 0, pruned: 0, embedded: 1 });
    const beta = harnessFacts(dbPath).find((row) => row.source.endsWith('beta.md#1'));
    expect(beta.id).toBe(rows.find((row) => row.source.endsWith('beta.md#1')).id);
    expect(beta.value).toContain('rolled back');

    unlinkSync(join(claude, 'alpha.md'));
    rmSync(hermes, { recursive: true, force: true });
    const pruned = await ingestHarnessMemory({ home, dbPath, embed, apply: true });
    expect(pruned).toMatchObject({ pruned: 1, inserted: 0, updated: 0 });
    const remaining = harnessFacts(dbPath);
    expect(remaining.some((row) => row.source.endsWith('alpha.md#1'))).toBe(false);
    expect(remaining.filter((row) => row.source.startsWith('harness-memory:hermes:'))).toHaveLength(2);
    const check = new Database(dbPath, { readonly: true });
    expect((check.query("SELECT count(*) AS n FROM facts WHERE id = 'unrelated'").get() as any).n).toBe(1);
    expect((check.query('SELECT count(*) AS n FROM fact_embeddings WHERE fact_id NOT IN (SELECT id FROM facts)').get() as any).n).toBe(0);
    check.close();
  });

  test('long notes become ordered chunks and invalid embeddings abort before any write', async () => {
    const { home, claude, dbPath } = fixture();
    const para = 'z'.repeat(MAX_CHUNK_CHARS - 10);
    writeFileSync(join(claude, 'long.md'), `---\nname: long\nmetadata:\n  type: reference\n---\n\n${para}\n\n${para}\n`);
    await expect(ingestHarnessMemory({ home, dbPath, apply: true, embed: async (texts) => texts.map(() => [Number.NaN]) }))
      .rejects.toThrow('Invalid embedding');
    expect(harnessFacts(dbPath)).toHaveLength(0);
    await expect(ingestHarnessMemory({ home, dbPath, apply: true })).rejects.toThrow('embedding provider');

    const { embed } = counter();
    const result = await ingestHarnessMemory({ home, dbPath, embed, apply: true });
    expect(result.inserted).toBe(9);
    const longRows = harnessFacts(dbPath).filter((row) => row.source.includes('/long.md#'));
    expect(longRows.map((row) => row.source.split('#')[1])).toEqual(['1', '2']);
    expect(longRows[0].value).toContain('(part 1 of 2)');
  });
});
