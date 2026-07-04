import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import betweennessCentrality from 'graphology-metrics/centrality/betweenness.js';
import pagerank from 'graphology-metrics/centrality/pagerank.js';
import type { Store } from './store.js';
import type { PathResult, SubgraphResult, Community } from './types.js';

/**
 * Run PageRank, filtering out isolated nodes that prevent convergence.
 * Isolates get a score of 0.
 */
function safeRank(graph: Graph): Record<string, number> {
  const scores: Record<string, number> = {};

  // Separate connected nodes from isolates
  const connected = new Graph({ multi: false, type: 'undirected' });
  graph.forEachNode((id, attrs) => {
    if (graph.degree(id) > 0) {
      connected.addNode(id, attrs);
    } else {
      scores[id] = 0;
    }
  });
  graph.forEachEdge((_edge, _attrs, source, target) => {
    if (connected.hasNode(source) && connected.hasNode(target) && !connected.hasEdge(source, target)) {
      connected.addEdge(source, target);
    }
  });

  if (connected.order === 0) return scores;

  // getEdgeWeight: null → treat graph as unweighted (all edges weight 1).
  const pr = pagerank(connected, { maxIterations: 1000, tolerance: 1e-6, getEdgeWeight: null });
  for (const [id, score] of Object.entries(pr)) {
    scores[id] = score;
  }

  return scores;
}

interface NeighborInfo {
  id: string;
  title: string;
  edges: Array<{ sourceId: string; targetId: string; context: string }>;
}

export class KnowledgeGraph {
  private graph: Graph;
  private store: Store;

  private constructor(graph: Graph, store: Store) {
    this.graph = graph;
    this.store = store;
  }

  static fromStore(store: Store): KnowledgeGraph {
    const graph = new Graph({ multi: true, type: 'directed' });

    // Batch-load all nodes in one query (previously: allNodeIds() + getNode() × N = N+1 queries).
    for (const row of store.getAllNodes()) {
      let fm: Record<string, unknown>;
      try { fm = JSON.parse(row.frontmatter); } catch { fm = {}; }
      graph.addNode(row.id, { title: row.title, frontmatter: fm });
    }

    // Batch-load all edges in one query (previously: allNodeIds() + getEdgesFrom() × N = N+1 queries).
    for (const edge of store.getAllEdges()) {
      if (graph.hasNode(edge.sourceId) && graph.hasNode(edge.targetId)) {
        graph.addEdge(edge.sourceId, edge.targetId, { context: edge.context });
      }
    }

    return new KnowledgeGraph(graph, store);
  }

  nodeCount(): number {
    return this.graph.order;
  }

  edgeCount(): number {
    return this.graph.size;
  }

  neighbors(nodeId: string, depth: number): NeighborInfo[] {
    if (!this.graph.hasNode(nodeId)) return [];
    const visited = new Set<string>();
    const result: NeighborInfo[] = [];
    const queue: Array<{ id: string; d: number }> = [{ id: nodeId, d: 0 }];
    visited.add(nodeId);

    while (queue.length > 0) {
      const { id, d } = queue.shift()!;
      if (d >= depth) continue;

      const neighborIds = new Set([
        ...this.graph.outNeighbors(id),
        ...this.graph.inNeighbors(id),
      ]);

      for (const nid of neighborIds) {
        if (!visited.has(nid)) {
          visited.add(nid);
          // Read edge context from graph attrs (loaded in fromStore) — avoids
          // store.getEdgesFrom/To queries inside the BFS loop.
          const edgeKeys = [
            ...this.graph.outEdges(id).filter(k => this.graph.target(k) === nid),
            ...this.graph.inEdges(id).filter(k => this.graph.source(k) === nid),
          ];
          result.push({
            id: nid,
            title: this.graph.getNodeAttribute(nid, 'title'),
            edges: edgeKeys.map(k => ({
              sourceId: this.graph.source(k),
              targetId: this.graph.target(k),
              context: this.graph.getEdgeAttribute(k, 'context') as string,
            })),
          });
          queue.push({ id: nid, d: d + 1 });
        }
      }
    }

    return result;
  }

  findPaths(fromId: string, toId: string, maxDepth: number, maxPaths: number = 1000): PathResult[] {
    if (!this.graph.hasNode(fromId) || !this.graph.hasNode(toId)) return [];
    const undirected = this.toUndirected();
    const rawPaths = findAllSimplePaths(undirected, fromId, toId, maxDepth, maxPaths);

    return rawPaths.map(nodePath => {
      const edges: PathResult['edges'] = [];
      for (let i = 0; i < nodePath.length - 1; i++) {
        const src = nodePath[i];
        const tgt = nodePath[i + 1];
        // Read context from graph edge attrs — avoids store queries in path rendering.
        const edgeKeys = [
          ...this.graph.outEdges(src).filter(k => this.graph.target(k) === tgt),
          ...this.graph.outEdges(tgt).filter(k => this.graph.target(k) === src),
        ];
        edges.push({
          sourceId: src,
          targetId: tgt,
          context: edgeKeys.length > 0
            ? (this.graph.getEdgeAttribute(edgeKeys[0], 'context') as string)
            : '',
        });
      }
      return { nodes: nodePath, edges, length: nodePath.length - 1 };
    });
  }

  commonNeighbors(nodeA: string, nodeB: string): Array<{ id: string; title: string }> {
    if (!this.graph.hasNode(nodeA) || !this.graph.hasNode(nodeB)) return [];
    const neighborsA = new Set([
      ...this.graph.outNeighbors(nodeA),
      ...this.graph.inNeighbors(nodeA),
    ]);
    const neighborsB = new Set([
      ...this.graph.outNeighbors(nodeB),
      ...this.graph.inNeighbors(nodeB),
    ]);
    const common: Array<{ id: string; title: string }> = [];
    for (const id of neighborsA) {
      if (neighborsB.has(id)) {
        common.push({ id, title: this.graph.getNodeAttribute(id, 'title') });
      }
    }
    return common;
  }

  subgraph(nodeId: string, depth: number): SubgraphResult {
    if (!this.graph.hasNode(nodeId)) return { nodes: [], edges: [] };
    const visited = new Set<string>();
    const queue: Array<{ id: string; d: number }> = [{ id: nodeId, d: 0 }];
    visited.add(nodeId);

    while (queue.length > 0) {
      const { id, d } = queue.shift()!;
      if (d >= depth) continue;
      const allNeighbors = new Set([
        ...this.graph.outNeighbors(id),
        ...this.graph.inNeighbors(id),
      ]);
      for (const nid of allNeighbors) {
        if (!visited.has(nid)) {
          visited.add(nid);
          queue.push({ id: nid, d: d + 1 });
        }
      }
    }

    const nodes = [...visited].map(id => ({
      id,
      title: this.graph.getNodeAttribute(id, 'title'),
      frontmatter: (this.graph.getNodeAttribute(id, 'frontmatter') as Record<string, unknown>) ?? {},
    }));

    const edges: SubgraphResult['edges'] = [];
    for (const id of visited) {
      // Read edges from graph attrs — avoids store.getEdgesFrom() per BFS node.
      for (const k of this.graph.outEdges(id)) {
        const tgt = this.graph.target(k);
        if (visited.has(tgt)) {
          edges.push({
            sourceId: id,
            targetId: tgt,
            context: this.graph.getEdgeAttribute(k, 'context') as string,
          });
        }
      }
    }

    return { nodes, edges };
  }

  detectCommunities(resolution = 1.0): Community[] {
    const undirected = this.toUndirected();
    const assignments = louvain(undirected, { resolution });
    const communityMap = new Map<number, string[]>();

    for (const [nodeId, communityId] of Object.entries(assignments)) {
      const existing = communityMap.get(communityId) ?? [];
      existing.push(nodeId);
      communityMap.set(communityId, existing);
    }

    const pr = safeRank(undirected);
    const communities: Community[] = [];

    for (const [id, nodeIds] of communityMap) {
      const sorted = [...nodeIds].sort((a, b) => (pr[b] ?? 0) - (pr[a] ?? 0));
      const label = this.graph.hasNode(sorted[0])
        ? this.graph.getNodeAttribute(sorted[0], 'title')
        : sorted[0];
      const topTitles = sorted.slice(0, 5).map(nid =>
        this.graph.hasNode(nid) ? this.graph.getNodeAttribute(nid, 'title') : nid,
      );

      const tagCounts = new Map<string, number>();
      for (const nid of nodeIds) {
        // Read frontmatter from graph node attrs (loaded in fromStore) — avoids
        // store.getNode() per community member.
        const fm = this.graph.hasNode(nid)
          ? (this.graph.getNodeAttribute(nid, 'frontmatter') as Record<string, unknown> | undefined)
          : undefined;
        // Mirror index-pipeline.ts's guard: a note can carry non-array
        // `tags:` frontmatter (e.g. `tags: 42`), which round-trips through the
        // store as a scalar. `for...of` over a non-array throws "not iterable"
        // and — since detectCommunities runs at the end of every index() —
        // aborted the whole run after all upsert/embedding work was done.
        const tags: string[] = Array.isArray(fm?.tags)
          ? (fm.tags as unknown[]).filter((t): t is string => typeof t === 'string')
          : [];
        for (const tag of tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
      const topTags = [...tagCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([tag]) => tag);
      const tagStr = topTags.length > 0 ? ` Tags: ${topTags.join(', ')}.` : '';
      const summary = `Key members: ${topTitles.join(', ')}.${tagStr} ${nodeIds.length} nodes total.`;

      communities.push({ id, label, summary, nodeIds });
    }

    return communities;
  }

  bridges(limit: number): Array<{ id: string; title: string; score: number }> {
    const undirected = this.toUndirected();
    const bc = betweennessCentrality(undirected);
    return Object.entries(bc)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, score]) => ({
        id,
        title: this.graph.hasNode(id) ? this.graph.getNodeAttribute(id, 'title') : id,
        score,
      }));
  }

  centralNodes(
    limit: number,
    communityNodeIds?: string[],
  ): Array<{ id: string; title: string; score: number }> {
    const undirected = this.toUndirected();
    const pr = safeRank(undirected);
    let entries = Object.entries(pr);
    if (communityNodeIds) {
      const allowed = new Set(communityNodeIds);
      entries = entries.filter(([id]) => allowed.has(id));
    }
    return entries
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, score]) => ({
        id,
        title: this.graph.hasNode(id) ? this.graph.getNodeAttribute(id, 'title') : id,
        score,
      }));
  }

  private toUndirected(): Graph {
    const undirected = new Graph({ multi: false, type: 'undirected' });
    this.graph.forEachNode((id, attrs) => undirected.addNode(id, attrs));
    this.graph.forEachEdge((_edge, _attrs, source, target) => {
      if (!undirected.hasEdge(source, target)) undirected.addEdge(source, target);
    });
    return undirected;
  }
}

function findAllSimplePaths(
  graph: Graph,
  from: string,
  to: string,
  maxDepth: number,
  maxPaths: number,
): string[][] {
  const results: string[][] = [];

  // Hard cap on result count. On a dense graph with a 500-neighbor hub and
  // maxDepth≥3, DFS can enumerate millions of paths before the depth cut-off
  // fires, OOMing the MCP process. Abort the recursion as soon as the cap is
  // hit so we return a bounded, useful answer instead of crashing.
  function dfs(
    current: string,
    target: string,
    path: string[],
    visited: Set<string>,
    depth: number,
  ): boolean {
    if (results.length >= maxPaths) return true;
    if (current === target) {
      results.push([...path]);
      return results.length >= maxPaths;
    }
    if (depth >= maxDepth) return false;
    for (const neighbor of graph.neighbors(current)) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        path.push(neighbor);
        const hit = dfs(neighbor, target, path, visited, depth + 1);
        path.pop();
        visited.delete(neighbor);
        if (hit) return true;
      }
    }
    return false;
  }

  const visited = new Set([from]);
  dfs(from, to, [from], visited, 0);
  return results;
}
