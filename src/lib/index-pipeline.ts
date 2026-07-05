import { stat } from 'fs/promises';
import { join } from 'path';
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
  async index(vaultPath: string, resolution = 1.0, force = false): Promise<IndexStats> {
    const stats: IndexStats = {
      nodesIndexed: 0,
      nodesSkipped: 0,
      edgesIndexed: 0,
      communitiesDetected: 0,
      stubNodesCreated: 0,
    };

    const { nodes, edges, stubIds } = await parseVault(vaultPath);
    const previousPaths = this.store.getAllSyncPaths();

    // Pre-group edges by source for O(1) lookup
    const edgesBySource = new Map<string, typeof edges>();
    for (const edge of edges) {
      const list = edgesBySource.get(edge.sourceId) ?? [];
      list.push(edge);
      edgesBySource.set(edge.sourceId, list);
    }

    // Detect deleted files. Capture who linked TO each deleted file BEFORE
    // deleteNode wipes those edges (it deletes WHERE source OR target) — the
    // linkers themselves are usually mtime-unchanged and get SKIPPED below,
    // so without the reconciliation pass further down their freshly-parsed
    // `source → _stub/<deleted>.md` edges would never be inserted: the link
    // silently vanished while the orphan stub node was still created. This
    // is the exact mirror of the stub→real reconciliation below, in the
    // real→deleted direction.
    const currentPaths = new Set(nodes.map(n => n.id));
    const deletedLinkSources = new Set<string>();
    for (const oldPath of previousPaths) {
      if (!currentPaths.has(oldPath)) {
        for (const edge of this.store.getEdgesTo(oldPath)) {
          deletedLinkSources.add(edge.sourceId);
        }
        this.store.deleteNode(oldPath);
      }
    }

    // Track which sources got their content re-parsed this run, so we don't
    // double-process them in the stub-resolution pass below.
    const justIndexed = new Set<string>();

    // Index nodes (incremental)
    for (const node of nodes) {
      // Guard against ENOENT: a file deleted between parseVault() and the stat
      // loop (by a sync client, concurrent process, or user) must not abort the
      // entire index run. Skip the missing file and increment nodesSkipped so
      // callers can observe the gap; re-throw all other OS errors.
      let fileStat: Awaited<ReturnType<typeof stat>>;
      try {
        fileStat = await stat(join(vaultPath, node.id));
      } catch (e: any) {
        if (e.code === 'ENOENT') { stats.nodesSkipped++; continue; }
        throw e;
      }
      const mtime = fileStat.mtimeMs;
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

      this.store.upsertNode(node);

      // Compute and store embedding
      const tags = Array.isArray(node.frontmatter.tags) ? node.frontmatter.tags : [];
      const text = Embedder.buildEmbeddingText(node.title, tags as string[], node.content);
      const embedding = await this.embedder.embed(text);
      this.store.upsertEmbedding(node.id, embedding);

      // Re-index edges from this node
      this.store.deleteAllEdgesFrom(node.id);
      for (const edge of edgesBySource.get(node.id) ?? []) {
        this.store.insertEdge(edge);
        stats.edgesIndexed++;
      }

      this.store.upsertSync(node.id, mtime);
      justIndexed.add(node.id);
      stats.nodesIndexed++;
    }

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
      if (id.startsWith('_stub/') && !newStubIds.has(id)) {
        resolvedStubIds.push(id);
      }
    }

    // Track edge-only topology changes from the stub-resolution pass below
    // (they don't bump nodesIndexed/stubNodesCreated but still mutate the
    // graph and therefore require community recomputation).
    let edgeTopologyChanged = false;

    // Reconcile sources whose link target was deleted this run and that were
    // NOT re-parsed themselves (mtime unchanged → skipped above): re-insert
    // their freshly-parsed edges, which now point at the `_stub/` IDs the
    // stub-creation pass below materializes. Runs before the resolved-stub
    // pass, so a source fixed here can no longer appear in that pass's
    // getEdgesTo() lookups (its stale edges are already replaced).
    for (const sourceId of deletedLinkSources) {
      if (justIndexed.has(sourceId) || !currentPaths.has(sourceId)) continue;
      this.store.deleteAllEdgesFrom(sourceId);
      for (const edge of edgesBySource.get(sourceId) ?? []) {
        this.store.insertEdge(edge);
        stats.edgesIndexed++;
      }
      edgeTopologyChanged = true;
    }

    if (resolvedStubIds.length > 0) {
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
      edgeTopologyChanged = true;
    }

    // Create stub nodes
    for (const stubId of stubIds) {
      if (!this.store.getNode(stubId)) {
        this.store.upsertNode({
          id: stubId,
          title: stubId.replace('_stub/', '').replace('.md', ''),
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
      edgeTopologyChanged
    ) {
      const kg = KnowledgeGraph.fromStore(this.store);
      const communities = kg.detectCommunities(resolution);
      this.store.clearCommunities();
      for (const c of communities) {
        this.store.upsertCommunity(c);
      }
      stats.communitiesDetected = communities.length;
    }

    return stats;
  }
}
