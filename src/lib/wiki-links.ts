export interface RawLink {
  raw: string;       // the part to resolve (path or bare name)
  display: string | null;  // pipe alias display text, if any
}

/**
 * Strip fenced (```…```) and inline (`…`) code spans from markdown so that
 * `#`-prefixed tokens and `[[…]]` sequences inside code are not mistaken for
 * inline tags or wiki links. Exported so parser.extractInlineTags reuses the
 * exact same rule the wiki-link extractor relies on.
 */
export function stripCode(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '');
}

/**
 * Extract wiki links from markdown, ignoring code blocks and embedded images.
 */
export function extractWikiLinks(markdown: string): RawLink[] {
  const links: RawLink[] = [];

  // Remove code blocks first
  const withoutCode = stripCode(markdown);

  // Match [[...]] but not ![[...]]
  const pattern = /(?<!!)\[\[([^\]]+)\]\]/g;
  let match;
  while ((match = pattern.exec(withoutCode)) !== null) {
    const inner = match[1];
    const pipeIndex = inner.indexOf('|');
    if (pipeIndex !== -1) {
      links.push({
        raw: inner.substring(0, pipeIndex),
        display: inner.substring(pipeIndex + 1),
      });
    } else {
      links.push({ raw: inner, display: null });
    }
  }

  return links;
}

/**
 * Build a lookup table mapping filename stems to their full paths.
 */
export function buildStemLookup(allPaths: string[]): Map<string, string[]> {
  const lookup = new Map<string, string[]>();
  for (const p of allPaths) {
    const stem = p.replace(/\.md$/, '').split('/').pop()!;
    const existing = lookup.get(stem) ?? [];
    existing.push(p);
    lookup.set(stem, existing);
  }
  return lookup;
}

/**
 * Resolve a wiki link reference to a vault-relative path.
 * Returns null for unresolvable links (these become stub nodes).
 */
export function resolveLink(
  raw: string,
  stemLookup: Map<string, string[]>,
  allPathsSet?: Set<string>,
): string | null {
  // Strip Obsidian heading/block anchors ([[Note#Heading]], [[Note#^blockid]]):
  // the '#...' subpath addresses a location WITHIN the target note, not a
  // separate file, so it must not participate in path/stem resolution.
  // Without this, an existing note is misclassified as unresolvable and the
  // parser mints a phantom `_stub/Note#Heading.md` per distinct anchor instead
  // of an edge to the real note (finding wiki-links.ts:68).
  const filePart = raw.split('#')[0];

  // Path-qualified: try direct match first
  const withMd = filePart.endsWith('.md') ? filePart : filePart + '.md';
  const pathSet = allPathsSet ?? new Set([...stemLookup.values()].flat());
  if (pathSet.has(withMd)) {
    return withMd;
  }

  // Bare name: look up stem
  const stem = filePart.split('/').pop()!;
  const candidates = stemLookup.get(stem);
  if (!candidates || candidates.length === 0) {
    return null;  // stub node
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  // Ambiguous — prefer path-qualified match if the file part includes a directory
  if (filePart.includes('/')) {
    const match = candidates.find(c => c.startsWith(filePart.replace(/\.md$/, '')));
    if (match) return match;
  }

  // Fall back to first match and log warning
  console.warn(`Ambiguous wiki link [[${raw}]]: ${candidates.join(', ')}. Using first match.`);
  return candidates[0];
}
