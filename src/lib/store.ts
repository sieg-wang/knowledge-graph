import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { ParsedNode, ParsedEdge, SearchResult } from './types.js';

export class Store {
  db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    sqliteVec.load(this.db);
    this.createSchema();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT,
        frontmatter TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_nodes_title ON nodes(title);
      CREATE INDEX IF NOT EXISTS idx_nodes_title_lower ON nodes(LOWER(title));

      CREATE TABLE IF NOT EXISTS communities (
        id INTEGER PRIMARY KEY,
        label TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        node_ids TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS sync (
        path TEXT PRIMARY KEY,
        mtime INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- WARNING (finding store.ts:52): both nodes_fts (external-content fts5)
      -- and nodes_vec (vec0) are keyed by the IMPLICIT rowid of nodes, whose
      -- PRIMARY KEY is TEXT. SQLite VACUUM may renumber such rowids WITHOUT
      -- rewriting the rowids stored inside these shadow tables, silently
      -- attaching embeddings / FTS rows to the wrong notes. Do NOT run VACUUM on
      -- kg.db; if you must, follow it with "kg index --force" to rebuild.
      -- TODO(knowledge-graph-A-10): give nodes an INTEGER PRIMARY KEY and key
      -- these tables by it (schema migration — out of scope for this pass).
      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts
        USING fts5(title, content, content='nodes', content_rowid='rowid');

      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_vec
        USING vec0(embedding float[384]);
    `);
  }

  upsertNode(node: ParsedNode): void {
    this.db.transaction(() => {
      // FTS5 content-sync tables require manual delete-before-reinsert.
      // We must fetch the ACTUAL old values for the FTS5 delete command.
      const existing = this.db.prepare(
        'SELECT rowid, title, content FROM nodes WHERE id = ?'
      ).get(node.id) as { rowid: number; title: string; content: string } | undefined;

      if (existing) {
        this.db.prepare(
          "INSERT INTO nodes_fts(nodes_fts, rowid, title, content) VALUES('delete', ?, ?, ?)"
        ).run(existing.rowid, existing.title, existing.content);
      }

      this.db.prepare(`
        INSERT INTO nodes (id, title, content, frontmatter)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          content = excluded.content,
          frontmatter = excluded.frontmatter
      `).run(node.id, node.title, node.content, JSON.stringify(node.frontmatter));

      const row = this.db.prepare(
        'SELECT rowid FROM nodes WHERE id = ?'
      ).get(node.id) as { rowid: number };

      this.db.prepare(
        'INSERT INTO nodes_fts(rowid, title, content) VALUES(?, ?, ?)'
      ).run(row.rowid, node.title, node.content);
    })();
  }

  getNode(id: string): (ParsedNode & { rowid: number }) | undefined {
    const row = this.db.prepare(
      'SELECT rowid, id, title, content, frontmatter FROM nodes WHERE id = ?'
    ).get(id) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      frontmatter: JSON.parse(row.frontmatter),
      rowid: row.rowid,
    };
  }

  allNodeIds(): string[] {
    return this.db.prepare('SELECT id FROM nodes').all().map((r: any) => r.id);
  }

  /** All nodes with frontmatter string for alias scanning. One query. */
  getAllNodes(): Array<{ id: string; title: string; frontmatter: string }> {
    return this.db.prepare('SELECT id, title, frontmatter FROM nodes').all() as Array<{
      id: string; title: string; frontmatter: string;
    }>;
  }

  /** All edges. One query — used for batch graph loading in KnowledgeGraph.fromStore. */
  getAllEdges(): Array<{ sourceId: string; targetId: string; context: string }> {
    return this.db.prepare('SELECT source_id, target_id, context FROM edges').all().map((r: any) => ({
      sourceId: r.source_id,
      targetId: r.target_id,
      context: r.context,
    }));
  }

  insertEdge(edge: ParsedEdge): void {
    this.db.prepare(
      'INSERT INTO edges (source_id, target_id, context) VALUES (?, ?, ?)'
    ).run(edge.sourceId, edge.targetId, edge.context);
  }

  getEdgesFrom(nodeId: string): Array<ParsedEdge & { id: number }> {
    return this.db.prepare(
      'SELECT id, source_id, target_id, context FROM edges WHERE source_id = ?'
    ).all(nodeId).map((r: any) => ({
      id: r.id,
      sourceId: r.source_id,
      targetId: r.target_id,
      context: r.context,
    }));
  }

  getEdgesTo(nodeId: string): Array<ParsedEdge & { id: number }> {
    return this.db.prepare(
      'SELECT id, source_id, target_id, context FROM edges WHERE target_id = ?'
    ).all(nodeId).map((r: any) => ({
      id: r.id,
      sourceId: r.source_id,
      targetId: r.target_id,
      context: r.context,
    }));
  }

  countEdgesFrom(nodeId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM edges WHERE source_id = ?'
    ).get(nodeId) as { cnt: number };
    return row.cnt;
  }

  countEdgesTo(nodeId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM edges WHERE target_id = ?'
    ).get(nodeId) as { cnt: number };
    return row.cnt;
  }

  getEdgeSummariesFrom(nodeId: string): Array<{ nodeId: string; title: string }> {
    return this.db.prepare(`
      SELECT DISTINCT e.target_id, n.title
      FROM edges e
      LEFT JOIN nodes n ON n.id = e.target_id
      WHERE e.source_id = ?
    `).all(nodeId).map((r: any) => ({
      nodeId: r.target_id,
      title: r.title ?? r.target_id,
    }));
  }

  getEdgeSummariesTo(nodeId: string): Array<{ nodeId: string; title: string }> {
    return this.db.prepare(`
      SELECT DISTINCT e.source_id, n.title
      FROM edges e
      LEFT JOIN nodes n ON n.id = e.source_id
      WHERE e.target_id = ?
    `).all(nodeId).map((r: any) => ({
      nodeId: r.source_id,
      title: r.title ?? r.source_id,
    }));
  }

  deleteNode(id: string): void {
    this.db.transaction(() => {
      // FTS5 delete requires actual old values, not empty strings
      const row = this.db.prepare(
        'SELECT rowid, title, content FROM nodes WHERE id = ?'
      ).get(id) as { rowid: number; title: string; content: string } | undefined;

      if (row) {
        this.db.prepare(
          "INSERT INTO nodes_fts(nodes_fts, rowid, title, content) VALUES('delete', ?, ?, ?)"
        ).run(row.rowid, row.title, row.content);
        // sqlite-vec requires BigInt rowids via better-sqlite3
        this.db.prepare('DELETE FROM nodes_vec WHERE rowid = ?').run(BigInt(row.rowid));
      }

      this.db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM edges WHERE source_id = ? OR target_id = ?').run(id, id);
      this.db.prepare('DELETE FROM sync WHERE path = ?').run(id);
    })();
  }

  deleteAllEdgesFrom(nodeId: string): void {
    this.db.prepare('DELETE FROM edges WHERE source_id = ?').run(nodeId);
  }

  // `limit` mirrors searchVector's signature — a hardcoded LIMIT 20 silently
  // capped caller-supplied limits above 20 (callers slice AFTER this call).
  searchFullText(query: string, limit = 20): SearchResult[] {
    const runFts = (q: string) =>
      this.db.prepare(`
        SELECT n.id, n.title, rank,
          snippet(nodes_fts, 1, '>>>', '<<<', '...', 40) as excerpt
        FROM nodes_fts f
        JOIN nodes n ON n.rowid = f.rowid
        WHERE nodes_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(q, limit).map((r: any) => ({
        nodeId: r.id,
        title: r.title,
        score: -r.rank as number,
        excerpt: (r.excerpt ?? '') as string,
      }));

    try {
      return runFts(query);
    } catch (e: any) {
      // FTS5 syntax errors: "unterminated string", "fts5: syntax error", etc.
      const msg = e.message ?? '';
      if (msg.includes('fts5') || msg.includes('unterminated') || msg.includes('syntax error')) {
        return runFts(`"${query.replace(/"/g, '""')}"`);
      }
      throw e;
    }
  }

  upsertEmbedding(nodeId: string, embedding: Float32Array): void {
    const node = this.getNode(nodeId);
    if (!node) {
      console.warn(`upsertEmbedding: node ${nodeId} not found, skipping`);
      return;
    }
    // sqlite-vec requires BigInt rowids via better-sqlite3
    this.db.prepare('DELETE FROM nodes_vec WHERE rowid = ?').run(BigInt(node.rowid));
    this.db.prepare(
      'INSERT INTO nodes_vec(rowid, embedding) VALUES (?, ?)'
    ).run(BigInt(node.rowid), Buffer.from(embedding.buffer));
  }

  searchVector(embedding: Float32Array, limit = 20): SearchResult[] {
    return this.db.prepare(`
      SELECT v.rowid, v.distance, n.id, n.title, n.content
      FROM nodes_vec v
      JOIN nodes n ON n.rowid = v.rowid
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    `).all(Buffer.from(embedding.buffer), limit).map((r: any) => ({
      nodeId: r.id,
      title: r.title,
      score: 1 - r.distance,
      excerpt: firstParagraph(r.content ?? '', 200),
    }));
  }

  upsertSync(path: string, mtime: number): void {
    this.db.prepare(`
      INSERT INTO sync (path, mtime, indexed_at) VALUES (?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, indexed_at = excluded.indexed_at
    `).run(path, mtime, Date.now());
  }

  getSyncMtime(path: string): number | undefined {
    const row = this.db.prepare(
      'SELECT mtime FROM sync WHERE path = ?'
    ).get(path) as { mtime: number } | undefined;
    return row?.mtime;
  }

  getAllSyncPaths(): Set<string> {
    return new Set(
      this.db.prepare('SELECT path FROM sync').all().map((r: any) => r.path)
    );
  }

  /** Read a meta value (e.g. the vault this DB is bound to). */
  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  /** Upsert a meta value. */
  setMeta(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  upsertCommunity(community: { id: number; label: string; summary: string; nodeIds: string[] }): void {
    this.db.prepare(`
      INSERT INTO communities (id, label, summary, node_ids) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        summary = excluded.summary,
        node_ids = excluded.node_ids
    `).run(community.id, community.label, community.summary, JSON.stringify(community.nodeIds));
  }

  clearCommunities(): void {
    this.db.prepare('DELETE FROM communities').run();
  }

  getAllCommunities(): Array<{ id: number; label: string; summary: string; nodeIds: string[] }> {
    return this.db.prepare('SELECT * FROM communities').all().map((r: any) => ({
      id: r.id,
      label: r.label,
      summary: r.summary,
      nodeIds: JSON.parse(r.node_ids),
    }));
  }

  close(): void {
    this.db.close();
  }
}

function firstParagraph(content: string, maxLen: number): string {
  const para = content.split(/\n\n+/).find(p => p.trim().length > 0 && !p.startsWith('#'));
  if (!para) return '';
  const trimmed = para.trim();
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) + '...' : trimmed;
}
