import { existsSync } from 'fs';
import { resolve, join } from 'path';
import { parseVault } from './parser.js';
import type { Store } from './store.js';
import { Embedder } from './embedder.js';
import { KnowledgeGraph } from './graph.js';

export interface IndexStats {
  nodesIndexed: number;
  nodesSkipped: number;
  edgesIndexed: number;
  communitiesDetected: number;
  stubNodesCreated: number;
}

export class IndexPipeline {
  constructor(
    private store: Store,
    private embedder: Embedder,
  ) {}

  // `force` bypasses the mtime skip so every file is re-parsed and re-embedded
  // (a true full rebuild). It deliberately does NOT wipe the sync table: the
  // CLI's old `--force` path did `DELETE FROM sync`, which emptied
  // `previousPaths` below and thereby DISABLED deleted-file detection — nodes,
  // edges, and embeddings for files removed from the vault survived a
  // `--force` run indefinitely and kept surfacing in search (finding
  // cli/index.ts:57). Keeping sync intact lets the deletion loop run while
  // force re-indexes everything; upsertSync overwrites stale mtimes so the
  // sync table still self-heals.
  // `allowEmpty` bypasses the zero-files mass-deletion tripwire (below) for the
  // rare legitimate case of intentionally emptying a vault.
  async index(vaultPath: string, resolution = 1.0, force = false, allowEmpty = false): Promise<IndexStats> {
    const stats: IndexStats = {
      nodesIndexed: 0,
      nodesSkipped: 0,
      edgesIndexed: 0,
      communitiesDetected: 0,
      stubNodesCreated: 0,
    };

    // Bind the DB to a single vault. dbPath is derived from dataDir alone, so
    // two vaults sharing the default KG_DATA_DIR resolve to the SAME kg.db;
    // indexing the second would treat every path of the first as "deleted" and
    // silently wipe its index (finding config.ts:35). Record the vault on first
    // index; refuse any later run against a different one.
    const resolvedVault = resolve(vaultPath);
    const boundVault = this.store.getMeta('vault_path');
    if (boundVault === undefined) {
      this.store.setMeta('vault_path', resolvedVault);
    } else if (boundVault !== resolvedVault) {
      throw new Error(
        `This database is bound to vault ${boundVault}, refusing to index ${resolvedVault}. ` +
        `Set a distinct KG_DATA_DIR per vault.`,
      );
    }

    const { nodes, edges, stubIds } = await parseVault(vaultPath);
    const previousPaths = this.store.getAllSyncPaths();

    // Mass-deletion tripwire (finding index-pipeline.ts:148): parseVault returns
    // 0 files not only when the vault is genuinely empty but when the vault
    // directory exists yet is empty — a stale/unmounted mountpoint, an external
    // volume that failed to remount, a cloud-sync dir that hasn't populated. In
    // that window the deletion pass below would delete EVERY node/edge/embedding
    // with no error (a missing directory aborts safely on readdir ENOENT; an
    // existing-but-empty one does not). Refuse to wipe when the sync table shows
    // we PREVIOUSLY indexed on-disk files here (exactly what an unmount makes
    // vanish at once); the caller must pass allowEmpty to confirm a real
    // full-empty. Keying on the sync table (not all store nodes) deliberately
    // excludes writer-created ghosts, which carry no sync row and are legitimately
    // reaped when their file is deleted.
    if (!allowEmpty && nodes.length === 0 && previousPaths.size > 0) {
      throw new Error(
        `Vault ${resolvedVault} parsed 0 files but the sync table holds ${previousPaths.size} ` +
        `previously-indexed files — refusing to wipe the store (an unmounted/empty mountpoint ` +
        `would silently destroy the index). Pass allowEmpty to confirm a genuine full-empty.`,
      );
    }

    // Pre-group edges by source for O(1) lookup
    const edgesBySource = new Map<string, typeof edges>();
    for (const edge of edges) {
      const list = edgesBySource.get(edge.sourceId) ?? [];
      list.push(edge);
      edgesBySource.set(edge.sourceId, list);
    }

    // Deletion-detection candidate set: sync paths UNION all real (non-stub)
    // node ids. A node created via VaultWriter.indexFile (kg_create_node) is
    // upserted WITHOUT a sync row, so a sync-only candidate set could never
    // detect its on-disk deletion — it would linger in search/graph forever
    // (finding index-pipeline.ts:41). Stubs are excluded: they are synthetic
    // and handled by the stub-reconciliation passes below.
    const deletionCandidates = new Set(previousPaths);
    for (const id of this.store.allNodeIds()) {
      if (!id.startsWith('_stub/')) deletionCandidates.add(id);
    }

    const currentPaths = new Set(nodes.map(n => n.id));
    // Sources that linked TO a file deleted this run; captured (before their
    // edges are wiped) so their `source → _stub/<deleted>.md` edges can be
    // re-inserted even though the source itself is mtime-skipped. The actual
    // deletion + this reconciliation run together, AFTER the embedding loop,
    // in one transaction (see below) — see finding index-pipeline.ts:66.
    const deletedLinkSources = new Set<string>();
    let nodesDeleted = 0;

    // Track which sources got their content re-parsed this run, so we don't
    // double-process them in the stub-resolution pass below.
    const justIndexed = new Set<string>();

    // Index nodes (incremental)
    for (const node of nodes) {
      // Use the content-snapshot mtime parseVault captured at read time (rather
      // than a fresh stat here, seconds later after other files' embeddings):
      // the mtime must describe the SAME bytes we are about to store, or a file
      // edited during the embedding phase gets its post-edit mtime persisted
      // with pre-edit content and is skipped forever (finding index-pipeline.ts:82).
      // parseVault always sets mtimeMs and already dropped any file it could not
      // read, so a missing value here is unreachable.
      const mtime = node.mtimeMs ?? 0;
      const prevMtime = this.store.getSyncMtime(node.id);

      // Skip only when the mtime is UNCHANGED. The previous `prevMtime >= mtime`
      // check skipped files whose mtime DECREASED — but git checkout, cp -p
      // restore, rsync, and Dropbox routinely backdate a CHANGED file's mtime
      // to <= the recorded value, which then silently retained stale content,
      // edges, and embeddings. Any mtime difference (up or down) must re-index.
      if (!force && prevMtime !== undefined && prevMtime === mtime) {
        stats.nodesSkipped++;
        continue;
      }

      // Compute the embedding OUTSIDE the transaction (it is async), then commit
      // ALL of this file's synchronous mutations atomically. Without the wrapper
      // a reader between deleteAllEdgesFrom and insertEdge (or between the vec
      // DELETE and INSERT) sees a half-updated node, and a mid-file throw leaves
      // stale-content/partial-edge state committed (finding index-pipeline.ts:100).
      const tags = Array.isArray(node.frontmatter.tags) ? node.frontmatter.tags : [];
      const text = Embedder.buildEmbeddingText(node.title, tags as string[], node.content);
      const embedding = await this.embedder.embed(text);

      const nodeEdges = edgesBySource.get(node.id) ?? [];
      this.store.db.transaction(() => {
        this.store.upsertNode(node);
        this.store.upsertEmbedding(node.id, embedding);
        this.store.deleteAllEdgesFrom(node.id);
        for (const edge of nodeEdges) {
          this.store.insertEdge(edge);
        }
        this.store.upsertSync(node.id, mtime);
      })();
      stats.edgesIndexed += nodeEdges.length;
      justIndexed.add(node.id);
      stats.nodesIndexed++;
    }

    // Track edge-only topology changes (they don't bump nodesIndexed /
    // stubNodesCreated but still mutate the graph → require community rerun).
    let edgeTopologyChanged = false;

    // Deleted-file handling + linker reconciliation, committed atomically AFTER
    // the embedding loop. Running the deletion here (not at the top of index())
    // means a crash DURING the embedding loop leaves the deleted target still in
    // `sync`, so the next run re-fires deletion detection and can recover; and
    // wrapping deleteNode together with the compensating `A → _stub/<deleted>.md`
    // re-insertion in one transaction guarantees the linker edge is never lost
    // in the window between them (finding index-pipeline.ts:66).
    this.store.db.transaction(() => {
      for (const oldPath of deletionCandidates) {
        if (!currentPaths.has(oldPath)) {
          // Re-verify against the live filesystem before deleting. currentPaths
          // is the parse SNAPSHOT (built at line ~77); a node created via
          // kg_create_node in another process during index()'s parse window is
          // in allNodeIds() (read after the parse) but absent from the snapshot,
          // and would be destroyed here even though its file is on disk and the
          // creating client was told "created". A file that still exists is
          // never a deleted file, regardless of snapshot age (finding
          // index-pipeline.ts:73).
          if (existsSync(join(vaultPath, oldPath))) continue;
          for (const edge of this.store.getEdgesTo(oldPath)) {
            deletedLinkSources.add(edge.sourceId);
          }
          this.store.deleteNode(oldPath);
          nodesDeleted++;
        }
      }
      for (const sourceId of deletedLinkSources) {
        if (justIndexed.has(sourceId) || !currentPaths.has(sourceId)) continue;
        this.store.deleteAllEdgesFrom(sourceId);
        for (const edge of edgesBySource.get(sourceId) ?? []) {
          this.store.insertEdge(edge);
          stats.edgesIndexed++;
        }
        edgeTopologyChanged = true;
      }
    })();

    // Reconcile previously-stub targets that now resolve to real files.
    //
    // When file A.md links `[[B]]` and B.md is missing, the parser emits
    // `A → _stub/B.md` and creates `_stub/B.md`. Later, when B.md is created,
    // A.md's mtime is unchanged so the loop above SKIPS it — leaving the
    // stale `A → _stub/B.md` edge in the DB and never inserting `A → B.md`.
    //
    // Fix: detect resolved stubs (in DB before this run, absent from
    // current parse), find every source that linked to them, and reconcile
    // those sources' edges from the freshly-parsed `edgesBySource` map.
    const newStubIds = new Set(stubIds);
    const resolvedStubIds: string[] = [];
    for (const id of this.store.allNodeIds()) {
      // `!currentPaths.has(id)` guards a real vault directory literally named
      // `_stub/`: its notes get ids like `_stub/Archived Idea.md` and ARE in the
      // current parse, so they must not be misclassified as resolved stubs and
      // deleted every run (finding index-pipeline.ts:181). A genuine resolved
      // stub is synthetic — never present on disk, hence never in currentPaths.
      if (id.startsWith('_stub/') && !newStubIds.has(id) && !currentPaths.has(id)) {
        resolvedStubIds.push(id);
      }
    }

    if (resolvedStubIds.length > 0) {
      // Commit the whole reconcile atomically: deleteAllEdgesFrom + the
      // compensating re-inserts + the orphaned-stub deletes. As bare autocommit
      // statements a throw/crash between a source's DELETE and its INSERT
      // committed the DELETE alone — and because the stub is then deleted no
      // later run reconciles that source again, permanently losing its edges.
      // The wrapper mirrors the deletion transaction at line 147 and also stops
      // a concurrent reader from observing a source with zero edges mid-rewrite
      // (finding index-pipeline.ts:196).
      this.store.db.transaction(() => {
        const sourcesToReconcile = new Set<string>();
        for (const stubId of resolvedStubIds) {
          for (const edge of this.store.getEdgesTo(stubId)) {
            // Skip sources we just re-parsed — their edges are already correct.
            if (!justIndexed.has(edge.sourceId)) {
              sourcesToReconcile.add(edge.sourceId);
            }
          }
        }
        for (const sourceId of sourcesToReconcile) {
          this.store.deleteAllEdgesFrom(sourceId);
          for (const edge of edgesBySource.get(sourceId) ?? []) {
            this.store.insertEdge(edge);
            stats.edgesIndexed++;
          }
        }
        // Drop the now-orphaned stub nodes.
        for (const stubId of resolvedStubIds) {
          this.store.deleteNode(stubId);
        }
      })();
      edgeTopologyChanged = true;
    }

    // Create stub nodes
    for (const stubId of stubIds) {
      if (!this.store.getNode(stubId)) {
        this.store.upsertNode({
          id: stubId,
          // Anchor the extension strip: plain .replace('.md','') removes the
          // FIRST '.md' substring, so `_stub/notes.mdx.md` yielded 'notesx.md'
          // instead of 'notes.mdx' (finding index-pipeline.ts:188).
          title: stubId.replace('_stub/', '').replace(/\.md$/, ''),
          content: '',
          frontmatter: { _stub: true },
        });
        stats.stubNodesCreated++;
      }
    }

    // Re-run community detection on ANY topology change. Previously only
    // gated on nodesIndexed/stubNodesCreated, which meant edge-only stub
    // reconciliation (the path the recent fix added) silently left
    // communities pointing at the pre-resolution graph — kg_communities
    // would report stale membership while kg_search saw the repaired edges.
    if (
      stats.nodesIndexed > 0 ||
      stats.stubNodesCreated > 0 ||
      edgeTopologyChanged ||
      // A deletion-only run (removed note with no inbound links, all others
      // mtime-skipped) still changes the graph and must refresh communities,
      // or kg_communities keeps serving the deleted node (finding index-pipeline.ts:201).
      nodesDeleted > 0
    ) {
      const kg = KnowledgeGraph.fromStore(this.store);
      const communities = kg.detectCommunities(resolution);
      // Atomic swap: wrap clear + upsert in a single transaction so that a
      // crash or throw mid-loop leaves the communities table in its OLD state
      // rather than empty (crash before first INSERT) or partial (crash
      // mid-loop). Without this, WAL mode's per-statement auto-commit means
      // clearCommunities() commits its DELETE alone, and any subsequent kill
      // makes getAllCommunities() return 0..K of the N expected communities
      // with no error — every kg_central --community M call then fails with
      // "Community M not found" for any community whose INSERT never ran.
      this.store.db.transaction(() => {
        this.store.clearCommunities();
        for (const c of communities) {
          this.store.upsertCommunity(c);
        }
      })();
      stats.communitiesDetected = communities.length;
    }

    return stats;
  }
}
