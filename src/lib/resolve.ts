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
 * Priority 2 (case-insensitive)– title.toLowerCase() = name.toLowerCase() → JS scan
 * Priority 3 (alias)           – frontmatter.aliases scan     → JS scan
 * Priority 4 (substring)       – title.toLowerCase() includes name.toLowerCase() → JS scan
 *
 * Resolve.ts previously issued a single `SELECT id, title, frontmatter FROM nodes`
 * with no WHERE clause and filtered in JS — parsing every node's frontmatter JSON
 * on every call even when an ID match was available. The hot paths (id / exact
 * title) now use targeted indexed SQL. Priorities 2–4 filter in JS over one
 * Store.getAllNodes() batch fetch: SQLite's default (no-ICU) LOWER() only folds
 * A–Z (breaking case-insensitive matching for accented-Latin titles) and its
 * LIKE operator treats a user's literal `_`/`%` as wildcards (a silent
 * wrong-node match on the write path). JS toLowerCase()/includes() is
 * Unicode-correct and wildcard-free, so results are identical to the original
 * pre-index behavior. The scan runs only after the O(1) indexed passes miss.
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

  // Priorities 2–4 all require a full node scan; fetch the rows once. Using
  // getAllNodes() (one batch query) also keeps resolve.ts independent of the
  // schema's column names.
  const lower = name.toLowerCase();
  const allNodes = store.getAllNodes();

  // Priority 2: case-insensitive title match (JS toLowerCase — Unicode-correct,
  // unlike SQLite's ASCII-only LOWER()).
  const ciMatches: NameMatch[] = [];
  for (const n of allNodes) {
    if (n.title.toLowerCase() === lower) {
      ciMatches.push({ nodeId: n.id, title: n.title, matchType: 'case-insensitive' });
    }
  }
  if (ciMatches.length > 0) return ciMatches;

  // Priority 3: alias match — scan frontmatter.
  const aliasMatches: NameMatch[] = [];
  for (const n of allNodes) {
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

  // Priority 4: substring match on title (JS includes — treats the user's
  // literal `_`/`%` as plain characters, unlike SQL LIKE wildcards).
  const substringMatches: NameMatch[] = [];
  for (const n of allNodes) {
    if (n.title.toLowerCase().includes(lower)) {
      substringMatches.push({ nodeId: n.id, title: n.title, matchType: 'substring' });
    }
  }
  return substringMatches;
}
