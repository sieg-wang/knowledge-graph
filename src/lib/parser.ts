import { readdir, readFile, stat } from 'fs/promises';
import { join, basename } from 'path';
import matter from 'gray-matter';
import {
  extractWikiLinks,
  buildStemLookup,
  resolveLink,
  stripCode,
} from './wiki-links.js';
import type { ParsedNode, ParsedEdge } from './types.js';

const EXCLUDED_DIRS = new Set(['.obsidian', '_FileOrganizer2000', 'attachments']);

export interface ParseResult {
  nodes: ParsedNode[];
  edges: ParsedEdge[];
  stubIds: Set<string>;
}

export async function parseVault(vaultPath: string): Promise<ParseResult> {
  const mdPaths = await collectMarkdownFiles(vaultPath);
  const stemLookup = buildStemLookup(mdPaths);
  const allPathsSet = new Set(mdPaths);
  const nodes: ParsedNode[] = [];
  const edges: ParsedEdge[] = [];
  const stubIds = new Set<string>();

  for (const relPath of mdPaths) {
    const absPath = join(vaultPath, relPath);

    // Capture the mtime at the SAME point we read the content, then carry it on
    // the node (index-pipeline uses it as the content-snapshot mtime instead of
    // a later stat — closes the TOCTOU where a file edited during the embedding
    // phase got its post-edit mtime stored with pre-edit content, finding
    // index-pipeline.ts:82). Both syscalls are guarded: a regular file deleted
    // between readdir and here (ENOENT), or a leftover odd entry (EISDIR/ELOOP),
    // must skip that one file — NOT abort the whole index run (finding
    // parser.ts:29). collectMarkdownFiles already excludes symlinks, so this
    // guard is the second line of defence for the plain readdir→read race.
    let raw: string;
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(absPath)).mtimeMs;
      raw = await readFile(absPath, 'utf-8');
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR' || code === 'ELOOP') {
        console.warn(`Skipping ${relPath}: ${code}`);
        continue;
      }
      throw e;
    }

    let fm: Record<string, unknown>;
    let content: string;
    try {
      const parsed = matter(raw);
      // gray-matter usually absorbs YAML errors internally and still returns
      // { data: {}, content: ... } — the catch branch below is a last
      // resort. More importantly, frontmatter is user-authored YAML, so
      // strip the three prototype-pollution keys before letting it flow
      // through the indexer (where it reaches Store.upsertNode and later
      // spreads in other objects).
      fm = sanitizeFrontmatter(parsed.data);
      content = parsed.content ?? raw;
    } catch {
      console.warn(`Malformed frontmatter in ${relPath}, treating as plain markdown`);
      fm = {};
      content = raw;
    }

    // `title:` is user-authored YAML — an array/number/blank value must fall
    // back to the filename. The previous unguarded cast let a non-string
    // reach Store.upsertNode, where better-sqlite3 cannot bind it: one
    // malformed note aborted the ENTIRE index run mid-way. Same failure
    // class as the scalar-tags (graph.ts) and scalar-aliases (resolve.ts)
    // guards.
    const title = typeof fm.title === 'string' && fm.title.trim()
      ? fm.title
      : basename(relPath, '.md');

    // Strip code spans before tag extraction so `#include`, CSS `#ff0000`,
    // etc. inside fenced/inline code do not mint phantom tags (parser.ts:59).
    const inlineTags = extractInlineTags(stripCode(content));
    const frontmatter = { ...fm };
    if (inlineTags.length > 0) {
      frontmatter.inline_tags = inlineTags;
    }

    nodes.push({ id: relPath, title, content, frontmatter, mtimeMs });

    const links = extractWikiLinks(content);
    const paragraphs = content.split(/\n\n+/);

    for (const link of links) {
      const targetId = resolveLink(link.raw, stemLookup, allPathsSet);
      const resolvedTarget = targetId ?? `_stub/${link.raw}.md`;

      if (!targetId) {
        stubIds.add(resolvedTarget);
      }

      const contextRaw = paragraphs.find(p => p.includes(`[[${link.raw}`))
        ?? paragraphs.find(p => p.includes(link.display ?? link.raw))
        ?? '';
      // Cap context at 500 chars. Without this, a note with no blank lines
      // stores the entire file content as edge context for every outgoing link
      // (a 100 KB note with 10 links writes 1 MB of context to the DB).
      // The CLI and MCP already truncate to 200 chars for display; the DB
      // should not need the full paragraph.
      // Truncate on a codepoint boundary: plain .slice() counts UTF-16 code
      // units, so an astral char (emoji, CJK Ext-B) straddling index 500 would
      // be split into a lone surrogate and PERSISTED as invalid Unicode in the
      // edges table. Spreading into codepoints first avoids the split (BMP
      // CJK, one code unit each, is unaffected). (finding parser.ts:86)
      const context = truncateCodepoints(contextRaw.trim(), 500);

      edges.push({
        sourceId: relPath,
        targetId: resolvedTarget,
        context,
      });
    }
  }

  return { nodes, edges, stubIds };
}

// Strip the three keys that can mutate Object.prototype when assigned via
// bracket notation anywhere downstream. We keep a plain object (rather than
// Object.create(null)) because downstream callers rely on standard object
// spreading and JSON.stringify, which work with plain objects.
//
// Exported so writer.ts can apply the same guard on its re-index path.
// Without this, frontmatter that flows through writer.indexFile() →
// store.upsertNode() bypasses the parser-side sanitization (Codex review #10).
export function sanitizeFrontmatter(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    out[key] = value;
  }
  return out;
}

// Truncate to at most `maxCodepoints` Unicode codepoints without splitting an
// astral-plane character across a UTF-16 surrogate boundary. Exported for unit
// tests.
export function truncateCodepoints(str: string, maxCodepoints: number): string {
  const cps = [...str];
  return cps.length > maxCodepoints ? cps.slice(0, maxCodepoints).join('') : str;
}

function extractInlineTags(content: string): string[] {
  const tags = new Set<string>();
  // Unicode-aware: the old ASCII pattern (`[a-zA-Z][\w-\/]*`, no /u flag)
  // silently dropped every non-ASCII inline tag — `#專案管理`, `#日本語`,
  // accented-Latin — which matters for this vault's zh-TW content. \p{L}
  // (any letter) + the /u flag matches Obsidian's own non-Latin tag support;
  // the lookbehind now also treats letters/digits/_ of ANY script as
  // word chars, so `word#x` / `字#x` stay non-tags (tags need a leading
  // boundary). Tag body still allows `-`, `_`, `/` for nested tags.
  const pattern = /(?<![\p{L}\p{N}_])#(\p{L}[\p{L}\p{N}_\-\/]*)/gu;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    tags.add(match[1]);
  }
  return [...tags];
}

async function collectMarkdownFiles(
  vaultPath: string,
  subdir = '',
): Promise<string[]> {
  const results: string[] = [];
  const dirPath = join(vaultPath, subdir);
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    // Skip ALL symlinks. A symlink named `*.md` can point outside the vault
    // (readFile would index a secret file's bytes — the read-path mirror of the
    // write-path vault-boundary guard), dangle (ENOENT), or target a directory
    // (EISDIR abort). The vault's own notes are regular files; anything reached
    // only via a symlink is out of scope for indexing (finding parser.ts:162).
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;

    const relPath = subdir ? `${subdir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...await collectMarkdownFiles(vaultPath, relPath));
    } else if (entry.name.endsWith('.md')) {
      results.push(relPath);
    }
  }

  return results;
}
