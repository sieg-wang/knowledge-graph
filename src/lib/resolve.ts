import type { Store } from './store.js';
import type { NameMatch } from './types.js';

/**
 * Resolve a node name to a single ID, throwing on no match or ambiguity.
 * Used by MCP tool handlers as the entry point for all fuzzy name resolution.
 */
export function requireMatch(name: string, store: Store): string {
  const matches = resolveNodeName(name, store);
  if (matches.length === 0) throw new Error(`No node found matching "${name}"`);
  if (
    matches.length > 1
    && matches[0].matchType !== 'exact'
    && matches[0].matchType !== 'id'
    && matches[0].matchType !== 'case-insensitive'
  ) {
    const candidates = matches.map(m => `"${m.title}" (${m.nodeId})`).join(', ');
    throw new Error(`Ambiguous name "${name}". Candidates: ${candidates}. Use the full node ID to disambiguate.`);
  }
  return matches[0].nodeId;
}

export function resolveNodeName(name: string, store: Store): NameMatch[] {
  const allNodes = store.db.prepare(
    'SELECT id, title, frontmatter FROM nodes'
  ).all() as Array<{ id: string; title: string; frontmatter: string }>;

  // Priority 0: exact ID match (with or without .md extension)
  const nameWithMd = name.endsWith('.md') ? name : name + '.md';
  const idMatch = allNodes.filter(n => n.id === name || n.id === nameWithMd);
  if (idMatch.length > 0) {
    return idMatch.map(n => ({ nodeId: n.id, title: n.title, matchType: 'id' as const }));
  }

  // Priority 1: exact title match
  const exact = allNodes.filter(n => n.title === name);
  if (exact.length > 0) {
    return exact.map(n => ({ nodeId: n.id, title: n.title, matchType: 'exact' as const }));
  }

  // Priority 2: case-insensitive title match
  const lower = name.toLowerCase();
  const caseInsensitive = allNodes.filter(n => n.title.toLowerCase() === lower);
  if (caseInsensitive.length > 0) {
    return caseInsensitive.map(n => ({
      nodeId: n.id, title: n.title, matchType: 'case-insensitive' as const,
    }));
  }

  // Priority 3: alias match
  const aliasMatches: NameMatch[] = [];
  for (const n of allNodes) {
    const fm = JSON.parse(n.frontmatter);
    const aliases: string[] = fm.aliases ?? [];
    if (aliases.some(a => a.toLowerCase() === lower)) {
      aliasMatches.push({ nodeId: n.id, title: n.title, matchType: 'alias' });
    }
  }
  if (aliasMatches.length > 0) return aliasMatches;

  // Priority 4: substring match on title
  const substring = allNodes.filter(n => n.title.toLowerCase().includes(lower));
  return substring.map(n => ({
    nodeId: n.id, title: n.title, matchType: 'substring' as const,
  }));
}
