import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolveConfig } from '../lib/config.js';
import { Store } from '../lib/store.js';
import { Embedder } from '../lib/embedder.js';
import { IndexPipeline } from '../lib/index-pipeline.js';
import { KnowledgeGraph } from '../lib/graph.js';
import { Search } from '../lib/search.js';
import { requireMatch as requireMatchBase } from '../lib/resolve.js';
import { VaultWriter } from '../lib/writer.js';
import { makeEnsureEmbedder } from '../lib/ensure-embedder.js';
import { makeWriteLock } from '../lib/write-lock.js';
import { mkdirSync } from 'fs';

// Config, store, and related singletons are initialized in main() so that a
// missing KG_VAULT_PATH (or any other resolveConfig error) surfaces as a
// clean stderr message rather than an unformatted stack trace on module load
// before the MCP stdio transport is connected.
let config: ReturnType<typeof resolveConfig>;
let store: Store;
let embedder: Embedder;
let search: Search;
let writer: VaultWriter;
let cachedGraph: KnowledgeGraph | null = null;
let ensureEmbedder: ReturnType<typeof makeEnsureEmbedder>;

// Serialize the mutating handlers (kg_index / kg_create_node / kg_annotate_node
// / kg_add_link). Clients pipeline overlapping tool calls, and these handlers
// interleave store reads/writes across await points — two overlapping mutations
// duplicate or drop edges and store stale content (finding mcp/index.ts:47).
const withWriteLock = makeWriteLock();

function getGraph(): KnowledgeGraph {
  if (!cachedGraph) {
    cachedGraph = KnowledgeGraph.fromStore(store);
  }
  return cachedGraph;
}

const server = new McpServer({
  name: 'knowledge-graph',
  version: '0.1.0',
});

function requireMatch(name: string): string {
  return requireMatchBase(name, store);
}

server.tool(
  'kg_index',
  'Parse vault and build/update the knowledge graph',
  { resolution: z.number().positive().optional().describe('Louvain resolution parameter (default 1.0)') },
  async ({ resolution }) => withWriteLock(async () => {
    await ensureEmbedder();
    const pipeline = new IndexPipeline(store, embedder);
    const stats = await pipeline.index(config.vaultPath, resolution ?? 1.0);
    cachedGraph = null; // Invalidate — graph structure changed
    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
  })
);

server.tool(
  'kg_node',
  'Get a node. Brief mode (default) returns metadata + connection titles. Full mode returns content + edge context.',
  {
    name: z.string().describe('Node name (fuzzy matched)'),
    brief: z.boolean().optional().describe('Brief mode: metadata + connection titles only (default true)'),
    maxContentLength: z.number().int().positive().optional().describe('Truncate content to N chars in full mode (default 2000)'),
  },
  async ({ name, brief, maxContentLength }) => {
    const nodeId = requireMatch(name);
    const node = store.getNode(nodeId);
    if (!node) throw new Error(`Node "${name}" not found`);
    const useBrief = brief ?? true;

    if (useBrief) {
      const outgoing = store.getEdgeSummariesFrom(nodeId);
      const incoming = store.getEdgeSummariesTo(nodeId);
      const result = {
        id: node.id,
        title: node.title,
        frontmatter: node.frontmatter,
        outgoingCount: store.countEdgesFrom(nodeId),
        incomingCount: store.countEdgesTo(nodeId),
        outgoing,
        incoming,
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    const limit = maxContentLength ?? 2000;
    const truncatedContent = node.content.length > limit
      ? node.content.slice(0, limit) + `\n\n... [truncated, ${node.content.length} chars total]`
      : node.content;
    const outgoing = store.getEdgesFrom(nodeId).map(e => ({
      ...e,
      context: e.context.length > 200 ? e.context.slice(0, 200) + '...' : e.context,
    }));
    const incoming = store.getEdgesTo(nodeId).map(e => ({
      ...e,
      context: e.context.length > 200 ? e.context.slice(0, 200) + '...' : e.context,
    }));
    return { content: [{ type: 'text', text: JSON.stringify({ ...node, content: truncatedContent, outgoing, incoming }, null, 2) }] };
  }
);

server.tool(
  'kg_neighbors',
  'Get connected nodes at N-hop depth',
  {
    name: z.string().describe('Node name (fuzzy matched)'),
    depth: z.number().int().positive().optional().describe('Hop depth (default 1)'),
  },
  async ({ name, depth }) => {
    const nodeId = requireMatch(name);
    const kg = getGraph();
    const neighbors = kg.neighbors(nodeId, depth ?? 1);
    return { content: [{ type: 'text', text: JSON.stringify(neighbors, null, 2) }] };
  }
);

server.tool(
  'kg_search',
  'Semantic or full-text search over the graph',
  {
    query: z.string().describe('Search query'),
    fulltext: z.boolean().optional().describe('Use full-text search instead of semantic'),
    limit: z.number().int().positive().optional().describe('Max results (default 20)'),
  },
  async ({ query, fulltext, limit }) => {
    let results;
    if (fulltext) {
      results = store.searchFullText(query, limit ?? 20);
    } else {
      await ensureEmbedder();
      results = await search.semantic(query, limit ?? 20);
    }
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  }
);

server.tool(
  'kg_paths',
  'Find connecting paths between two nodes',
  {
    from: z.string().describe('Source node name'),
    to: z.string().describe('Target node name'),
    maxDepth: z.number().int().positive().optional().describe('Maximum path depth (default 3)'),
  },
  async ({ from, to, maxDepth }) => {
    const fromId = requireMatch(from);
    const toId = requireMatch(to);
    const kg = getGraph();
    const paths = kg.findPaths(fromId, toId, maxDepth ?? 3);
    return { content: [{ type: 'text', text: JSON.stringify(paths, null, 2) }] };
  }
);

server.tool(
  'kg_common',
  'Find shared connections between two nodes',
  {
    nodeA: z.string().describe('First node name'),
    nodeB: z.string().describe('Second node name'),
  },
  async ({ nodeA, nodeB }) => {
    const idA = requireMatch(nodeA);
    const idB = requireMatch(nodeB);
    const kg = getGraph();
    const common = kg.commonNeighbors(idA, idB);
    return { content: [{ type: 'text', text: JSON.stringify(common, null, 2) }] };
  }
);

server.tool(
  'kg_subgraph',
  'Extract a local neighborhood as a self-contained graph',
  {
    name: z.string().describe('Center node name'),
    depth: z.number().int().positive().optional().describe('Hop depth (default 1)'),
  },
  async ({ name, depth }) => {
    const nodeId = requireMatch(name);
    const kg = getGraph();
    const sub = kg.subgraph(nodeId, depth ?? 1);
    return { content: [{ type: 'text', text: JSON.stringify(sub, null, 2) }] };
  }
);

server.tool(
  'kg_communities',
  'List detected communities',
  {},
  async () => {
    const communities = store.getAllCommunities();
    const summary = communities.map(c => ({
      id: c.id, label: c.label, summary: c.summary, memberCount: c.nodeIds.length,
    }));
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  }
);

server.tool(
  'kg_community',
  'Get a specific community',
  { id: z.string().describe('Community ID or label') },
  async ({ id }) => {
    const communities = store.getAllCommunities();
    const numId = /^\d+$/.test(id) ? parseInt(id) : NaN;
    const community = communities.find(c => c.id === numId || c.label === id);
    if (!community) throw new Error(`Community "${id}" not found`);
    return { content: [{ type: 'text', text: JSON.stringify(community, null, 2) }] };
  }
);

server.tool(
  'kg_bridges',
  'Find bridge nodes with highest betweenness centrality',
  { limit: z.number().int().positive().optional().describe('Max results (default 20)') },
  async ({ limit }) => {
    const kg = getGraph();
    const bridges = kg.bridges(limit ?? 20);
    return { content: [{ type: 'text', text: JSON.stringify(bridges, null, 2) }] };
  }
);

server.tool(
  'kg_central',
  'Find central nodes by PageRank',
  {
    community: z.string().optional().describe('Restrict to community ID'),
    limit: z.number().int().positive().optional().describe('Max results (default 20)'),
  },
  async ({ community, limit }) => {
    const kg = getGraph();
    let communityNodeIds: string[] | undefined;
    if (community) {
      // Bare parseInt would silently return NaN for "abc" and run unfiltered;
      // surface the bad input as a tool error instead.
      if (!/^\d+$/.test(community)) {
        throw new Error(`community: must be a non-negative integer ID (got ${JSON.stringify(community)})`);
      }
      const communities = store.getAllCommunities();
      const c = communities.find(c => c.id === parseInt(community, 10));
      // A valid-format but nonexistent ID (e.g. stale after re-indexing
      // renumbered communities) must error like kg_community does — running
      // unfiltered returns the GLOBAL ranking, a plausible but wrong answer.
      if (!c) throw new Error(`Community "${community}" not found`);
      communityNodeIds = c.nodeIds;
    }
    const central = kg.centralNodes(limit ?? 20, communityNodeIds);
    return { content: [{ type: 'text', text: JSON.stringify(central, null, 2) }] };
  }
);

server.tool(
  'kg_create_node',
  'Create a new node in the vault. Writes a markdown file with frontmatter and indexes it.',
  {
    title: z.string().describe('Node title (becomes the filename)'),
    directory: z.string().optional().describe('Directory within vault (e.g., "Concepts", "People", "Ideas"). Omit for vault root.'),
    content: z.string().describe('Markdown content for the node body'),
    frontmatter: z.record(z.string(), z.unknown()).optional().describe('YAML frontmatter fields (type, tags, status, related, etc.)'),
  },
  async ({ title, directory, content, frontmatter }) => withWriteLock(async () => {
    await ensureEmbedder();
    const relPath = await writer.createNode({
      title,
      directory,
      frontmatter: frontmatter ?? {},
      content,
    });
    cachedGraph = null;
    return { content: [{ type: 'text', text: JSON.stringify({ created: relPath }, null, 2) }] };
  })
);

server.tool(
  'kg_annotate_node',
  'Append content to an existing node. Use for agent notes, observations, or additional context.',
  {
    name: z.string().describe('Node name or ID (fuzzy matched)'),
    content: z.string().describe('Markdown content to append'),
  },
  async ({ name, content }) => withWriteLock(async () => {
    const nodeId = requireMatch(name);
    await ensureEmbedder();
    await writer.annotateNode(nodeId, content);
    cachedGraph = null;
    return { content: [{ type: 'text', text: JSON.stringify({ annotated: nodeId }, null, 2) }] };
  })
);

server.tool(
  'kg_add_link',
  'Add a wiki link from one node to another with context. Appends to the source file and creates an edge.',
  {
    source: z.string().describe('Source node name or ID'),
    target: z.string().describe('Target node reference (e.g., "People/Alice Smith" or "Widget Theory")'),
    context: z.string().describe('Why this link exists — the sentence or note explaining the connection'),
  },
  async ({ source, target, context }) => withWriteLock(async () => {
    const sourceId = requireMatch(source);
    await ensureEmbedder();
    await writer.addLink(sourceId, target, context);
    cachedGraph = null;
    return { content: [{ type: 'text', text: JSON.stringify({ linked: { from: sourceId, to: target } }, null, 2) }] };
  })
);

async function main() {
  // Resolve config inside main() so errors surface as clean messages rather
  // than raw stack traces on module load before the stdio transport connects.
  try {
    config = resolveConfig({});
    mkdirSync(config.dataDir, { recursive: true });
  } catch (err) {
    process.stderr.write(`knowledge-graph MCP: configuration error — ${(err as Error).message}\n`);
    process.exit(1);
  }

  store = new Store(config.dbPath);
  embedder = new Embedder();
  search = new Search(store, embedder);
  writer = new VaultWriter(config.vaultPath, store, embedder);
  ensureEmbedder = makeEnsureEmbedder(embedder);

  // Embedder is lazily initialized on first semantic search/index — no eager loading here
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// A post-config startup failure (new Store() throwing on a corrupt/locked/
// directory kg.db, or server.connect() rejecting) must surface as a non-zero
// exit with a stderr message — not be swallowed by a bare console.error that
// lets the event loop drain and exit 0, hiding the failure from the MCP client
// (finding mcp/index.ts:327).
main().catch((err) => {
  process.stderr.write(
    `knowledge-graph MCP: startup error — ${(err as Error)?.stack ?? String(err)}\n`,
  );
  process.exit(1);
});
