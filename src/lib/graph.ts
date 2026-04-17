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
    for (const id of store.allNodeIds()) {
      const node = store.getNode(id);
      if (node) graph.addNode(id, { title: node.title });
    }
    for (const nodeId of store.allNodeIds()) {
      for (const edge of store.getEdgesFrom(nodeId)) {
        if (graph.hasNode(edge.targetId)) {
          graph.addEdge(edge.sourceId, edge.targetId, { context: edge.context });
        }
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
          const edgesFromStore = [
            ...this.store.getEdgesFrom(id).filter(e => e.targetId === nid),
            ...this.store.getEdgesTo(id).filter(e => e.sourceId === nid),
          ];
          result.push({
            id: nid,
            title: this.graph.getNodeAttribute(nid, 'title'),
            edges: edgesFromStore.map(e => ({
              sourceId: e.sourceId,
              targetId: e.targetId,
              context: e.context,
            })),
          });
          queue.push({ id: nid, d: d + 1 });
        }
      }
    }

    return result;
  }

  findPaths(fromId: string, toId: string, maxDepth: number): PathResult[] {
    if (!this.graph.hasNode(fromId) || !this.graph.hasNode(toId)) return [];
    const undirected = this.toUndirected();
    const rawPaths = findAllSimplePaths(undirected, fromId, toId, maxDepth);

    return rawPaths.map(nodePath => {
      const edges: PathResult['edges'] = [];
      for (let i = 0; i < nodePath.length - 1; i++) {
        const src = nodePath[i];
        const tgt = nodePath[i + 1];
        const edgeData = [
          ...this.store.getEdgesFrom(src).filter(e => e.targetId === tgt),
          ...this.store.getEdgesFrom(tgt).filter(e => e.targetId === src),
        ];
        edges.push({
          sourceId: src,
          targetId: tgt,
          context: edgeData[0]?.context ?? '',
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
      frontmatter: this.store.getNode(id)?.frontmatter ?? {},
    }));

    const edges: SubgraphResult['edges'] = [];
    for (const id of visited) {
      for (const edge of this.store.getEdgesFrom(id)) {
        if (visited.has(edge.targetId)) {
          edges.push({
            sourceId: edge.sourceId,
            targetId: edge.targetId,
            context: edge.context,
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
        const node = this.store.getNode(nid);
        const tags: string[] = (node?.frontmatter?.tags as string[]) ?? [];
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
): string[][] {
  const results: string[][] = [];

  function dfs(
    current: string,
    target: string,
    path: string[],
    visited: Set<string>,
    depth: number,
  ) {
    if (current === target) {
      results.push([...path]);
      return;
    }
    if (depth >= maxDepth) return;
    for (const neighbor of graph.neighbors(current)) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        path.push(neighbor);
        dfs(neighbor, target, path, visited, depth + 1);
        path.pop();
        visited.delete(neighbor);
      }
    }
  }

  const visited = new Set([from]);
  dfs(from, to, [from], visited, 0);
  return results;
}
