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

  async index(vaultPath: string, resolution = 1.0): Promise<IndexStats> {
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

    // Detect deleted files
    const currentPaths = new Set(nodes.map(n => n.id));
    for (const oldPath of previousPaths) {
      if (!currentPaths.has(oldPath)) {
        this.store.deleteNode(oldPath);
      }
    }

    // Track which sources got their content re-parsed this run, so we don't
    // double-process them in the stub-resolution pass below.
    const justIndexed = new Set<string>();

    // Index nodes (incremental)
    for (const node of nodes) {
      const fileStat = await stat(join(vaultPath, node.id));
      const mtime = fileStat.mtimeMs;
      const prevMtime = this.store.getSyncMtime(node.id);

      if (prevMtime !== undefined && prevMtime >= mtime) {
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
