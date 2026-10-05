import type { Database } from 'bun:sqlite';

// Mirrors packages/memory/src/episodes.ts syncEpisodeDocument without initializing
// the memory package's global database. The caller owns the transaction.
export function syncEpisodeDocument(
  db: Database,
  episodeId: string,
  summary: string,
  metadata: Record<string, unknown> | undefined,
  entities: string[] = [],
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS episode_documents (
      episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS episode_documents_fts USING fts5(
      episode_id UNINDEXED,
      text
    );
  `);
  const metadataText = metadata ? JSON.stringify(metadata) : '';
  const searchText = [summary, entities.join(' '), metadataText].filter(Boolean).join('\n');
  db.prepare(`
    INSERT INTO episode_documents (episode_id, text, updated_at)
    VALUES (?, ?, strftime('%s','now'))
    ON CONFLICT(episode_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at
  `).run(episodeId, searchText);
  db.prepare('DELETE FROM episode_documents_fts WHERE episode_id = ?').run(episodeId);
  db.prepare('INSERT INTO episode_documents_fts (episode_id, text) VALUES (?, ?)').run(episodeId, searchText);
}
