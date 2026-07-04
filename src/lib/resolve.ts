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

/**
 * Priority-ordered name resolution. Each priority level stops early on a hit
 * so the expensive alias/full-scan passes only run when necessary.
 *
 * Priority 0 (id)              – exact id or id + ".md"      → indexed pk lookup
 * Priority 1 (exact)           – exact title match            → idx_nodes_title
 * Priority 2 (case-insensitive)– LOWER(title) = LOWER(name)  → idx_nodes_title_lower
 * Priority 3 (alias)           – frontmatter.aliases scan     → getAllNodes() full fetch
 * Priority 4 (substring)       – LOWER(title) LIKE %name%    → idx_nodes_title_lower
 *
 * Resolve.ts previously issued a single `SELECT id, title, frontmatter FROM nodes`
 * with no WHERE clause and filtered in JS — parsing every node's frontmatter JSON
 * on every call even when an ID match was available. The new approach uses
 * Store.getAllNodes() only for the alias pass (priority 3) and targeted indexed
 * SQL for all others, so the common paths are O(1) indexed lookups.
 */
export function resolveNodeName(name: string, store: Store): NameMatch[] {
  // Priority 0: exact ID match (with or without .md extension)
  const nameWithMd = name.endsWith('.md') ? name : name + '.md';
  const idRows = store.db.prepare(
    'SELECT id, title FROM nodes WHERE id = ? OR id = ?'
  ).all(name, nameWithMd) as Array<{ id: string; title: string }>;
  if (idRows.length > 0) {
    return idRows.map(n => ({ nodeId: n.id, title: n.title, matchType: 'id' as const }));
  }

  // Priority 1: exact title match
  const exactRows = store.db.prepare(
    'SELECT id, title FROM nodes WHERE title = ?'
  ).all(name) as Array<{ id: string; title: string }>;
  if (exactRows.length > 0) {
    return exactRows.map(n => ({ nodeId: n.id, title: n.title, matchType: 'exact' as const }));
  }

  // Priority 2: case-insensitive title match
  const lower = name.toLowerCase();
  const ciRows = store.db.prepare(
    'SELECT id, title FROM nodes WHERE LOWER(title) = ?'
  ).all(lower) as Array<{ id: string; title: string }>;
  if (ciRows.length > 0) {
    return ciRows.map(n => ({ nodeId: n.id, title: n.title, matchType: 'case-insensitive' as const }));
  }

  // Priority 3: alias match — must scan frontmatter; only reached if no title/ID matched.
  // Uses getAllNodes() (one batch query) instead of accessing store.db directly,
  // so resolve.ts does not depend on the schema's column names.
  const aliasMatches: NameMatch[] = [];
  for (const n of store.getAllNodes()) {
    let fm: Record<string, unknown>;
    try { fm = JSON.parse(n.frontmatter); } catch { fm = {}; }
    // Obsidian permits a scalar `aliases: MyAlias` (gray-matter → string),
    // and arrays can contain non-string elements (numbers/null). Normalize
    // to a string[] before matching so one malformed note can't crash the
    // whole alias pass (and with it nearly every MCP tool / CLI subcommand).
    const rawAliases = fm.aliases;
    const aliases: string[] = Array.isArray(rawAliases)
      ? rawAliases.filter((a): a is string => typeof a === 'string')
      : typeof rawAliases === 'string'
        ? [rawAliases]
        : [];
    if (aliases.some(a => a.toLowerCase() === lower)) {
      aliasMatches.push({ nodeId: n.id, title: n.title, matchType: 'alias' });
    }
  }
  if (aliasMatches.length > 0) return aliasMatches;

  // Priority 4: substring match on title
  const substringRows = store.db.prepare(
    "SELECT id, title FROM nodes WHERE LOWER(title) LIKE ('%' || ? || '%')"
  ).all(lower) as Array<{ id: string; title: string }>;
  return substringRows.map(n => ({ nodeId: n.id, title: n.title, matchType: 'substring' as const }));
}
