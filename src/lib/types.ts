export interface ParsedNode {
  id: string;           // path relative to vault root
  title: string;        // from frontmatter or filename
  content: string;      // full markdown
  frontmatter: Record<string, unknown>;
  // Content-snapshot mtime, captured by parseVault at the same moment it reads
  // `content`. Optional so the lighter store.upsertNode / stub-creation call
  // sites (which never touch sync) need not synthesize one; parseVault — the
  // sole producer of the nodes IndexPipeline.index consumes — always sets it.
  mtimeMs?: number;
}

export interface ParsedEdge {
  sourceId: string;
  targetId: string;     // resolved path
  context: string;      // enclosing paragraph
}

export interface Community {
  id: number;
  label: string;
  summary: string;
  nodeIds: string[];
}

export interface SearchResult {
  nodeId: string;
  title: string;
  score: number;
  excerpt: string;
}

export interface PathResult {
  nodes: string[];       // ordered node IDs along the path
  edges: Array<{         // edge context for each hop
    sourceId: string;
    targetId: string;
    context: string;
  }>;
  length: number;
}

export interface SubgraphResult {
  nodes: Array<{ id: string; title: string; frontmatter: Record<string, unknown> }>;
  edges: Array<{ sourceId: string; targetId: string; context: string }>;
}

export interface NameMatch {
  nodeId: string;
  title: string;
  matchType: 'id' | 'exact' | 'case-insensitive' | 'alias' | 'substring';
}
