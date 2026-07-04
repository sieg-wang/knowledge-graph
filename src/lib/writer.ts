import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  unlinkSync,
  realpathSync,
} from 'fs';
import { join, basename, dirname, resolve } from 'path';
import matter from 'gray-matter';
import type { Store } from './store.js';
import { Embedder } from './embedder.js';
import { resolveNodeName } from './resolve.js';
import { sanitizeFrontmatter } from './parser.js';

export interface CreateNodeOptions {
  title: string;
  directory?: string;
  frontmatter: Record<string, unknown>;
  content: string;
}

// Titles and directories reach createNode from MCP tool input (LLM-controlled)
// and from CLI users. Reject filesystem separators and control chars so a
// hostile or buggy caller cannot write outside the vault or overwrite arbitrary
// files. The set intentionally mirrors Windows + POSIX reserved chars so the
// same vault works on any host.
//
// Exported for unit tests; internal callers should use createNode/addLink.
export const INVALID_TITLE_CHARS = /[\x00-\x1f/\\:*?"<>|]/;

// addLink writes the literal text  `${context} [[${targetRef}]]`  into the
// source markdown. A target containing `]]`, `[[`, `|`, or a newline would
// break out of the wiki-link syntax (creating extra/extraneous links); a
// context containing the same characters would, on the next full reparse
// (parser.ts extractWikiLinks), materialize phantom edges the caller did
// not request — kg_add_link is meant to create exactly one link per call.
// Both regexes are deliberately strict — callers needing rich markdown
// should use annotateNode, not addLink.
//
// Codex review #5 (2026-05-03): added bracket/pipe rejection to context
// (was: control-char-only) so context cannot smuggle in extra wiki-links.
//
// Exported for unit tests.
export const INVALID_LINK_TARGET_CHARS = /[\x00-\x1f\[\]|]/;
export const INVALID_LINK_CONTEXT_CHARS = /[\x00-\x1f\[\]|]/;

function assertSafeTitle(title: string): void {
  if (!title || INVALID_TITLE_CHARS.test(title)) {
    throw new Error(
      `Unsafe title: ${JSON.stringify(title)} — contains path separator, control char, or reserved character`,
    );
  }
  if (title === '.' || title === '..') {
    throw new Error(`Unsafe title: "${title}" is a filesystem reference`);
  }
}

function assertSafeDirectory(directory: string | undefined): void {
  if (directory === undefined) return;
  // Allow forward slashes to nest subdirectories, but block parent refs,
  // absolute paths, and control chars.
  if (directory.startsWith('/') || directory.startsWith('\\')) {
    throw new Error(`Unsafe directory: ${JSON.stringify(directory)} — absolute paths not allowed`);
  }
  const segments = directory.split(/[/\\]/);
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new Error(`Unsafe directory: ${JSON.stringify(directory)} — contains empty or parent segment`);
    }
    if (INVALID_TITLE_CHARS.test(seg)) {
      throw new Error(`Unsafe directory segment: ${JSON.stringify(seg)}`);
    }
  }
}

/**
 * Throws if `absPath` is not strictly inside `vaultPath`. Prevents path
 * traversal via node IDs like `_stub/../../etc/secrets.md` — an untrusted
 * vault file can embed such links, which the parser emits verbatim as stub IDs.
 * Without this guard, `annotateNode` / `addLink` / `indexFile` would resolve the
 * `..` segments and write/read outside the vault root.
 */
function assertPathInVault(absPath: string, vaultPath: string, nodeId: string): void {
  // Canonicalize vault root — it could itself be a symlink.
  const realVault = realpathSync(vaultPath);

  // Resolve symlinks in absPath.  The file may not exist yet (annotateNode /
  // addLink guard fires before existsSync), so fall back to realpathSync on
  // the containing directory and re-attach the basename.  This still follows
  // any symlinks in ancestor dirs and eliminates all `..` segments, so both
  // the dotdot-traversal and symlink-escape threat classes are caught.
  let realPath: string;
  try {
    realPath = realpathSync(absPath);
  } catch {
    try {
      const realDir = realpathSync(dirname(absPath));
      realPath = join(realDir, basename(absPath));
    } catch {
      // The containing directory does not exist either (e.g. a traversal id
      // like `../../nonexistent/foo.md`). We cannot canonicalize symlinks, but
      // a lexically-resolved (`..`-normalized) path is enough to detect escape:
      // fall back to it and let the boundary check below throw the clean
      // "escapes vault" error rather than propagating a raw ENOENT.
      realPath = resolve(absPath);
    }
  }

  if (!realPath.startsWith(realVault + '/') && realPath !== realVault) {
    throw new Error(`Node ID escapes vault: ${nodeId}`);
  }
}

export class VaultWriter {
  // The embedder is optional so unit tests (and any caller that only needs
  // FTS/graph writes) can construct a writer without loading the model. When
  // present, indexFile computes + upserts the node's embedding so a node
  // created/annotated via MCP is immediately semantic-searchable — previously
  // only IndexPipeline.index embedded, so kg_create_node then kg_search
  // (semantic is the default) returned nothing until a full re-index.
  constructor(
    private vaultPath: string,
    private store: Store,
    private embedder?: Embedder,
  ) {}

  async createNode(opts: CreateNodeOptions): Promise<string> {
    assertSafeTitle(opts.title);
    assertSafeDirectory(opts.directory);

    const dir = opts.directory
      ? join(this.vaultPath, opts.directory)
      : this.vaultPath;
    mkdirSync(dir, { recursive: true });

    const filename = `${opts.title}.md`;
    const relPath = opts.directory ? `${opts.directory}/${filename}` : filename;
    const absPath = join(dir, filename);

    if (existsSync(absPath)) {
      throw new Error(`File already exists: ${relPath}`);
    }

    const fm = { title: opts.title, ...opts.frontmatter };
    const fileContent = matter.stringify(opts.content, fm);

    // Atomic publish: write to a sibling tmp path, then rename. A crash
    // mid-write leaves the tmp file behind (which we clean up on the next
    // attempt via the existsSync(absPath) guard above) instead of a
    // half-written <title>.md that subsequent indexing would treat as a
    // real, corrupt node.
    const tmpPath = `${absPath}.tmp.${process.pid}.${Date.now()}`;
    try {
      writeFileSync(tmpPath, fileContent, 'utf-8');
      renameSync(tmpPath, absPath);
    } catch (err) {
      try { unlinkSync(tmpPath); } catch { /* tmp may not exist */ }
      throw err;
    }

    // Index in store
    await this.indexFile(relPath);

    return relPath;
  }

  async annotateNode(nodeId: string, content: string): Promise<void> {
    const absPath = join(this.vaultPath, nodeId);
    assertPathInVault(absPath, this.vaultPath, nodeId);
    if (!existsSync(absPath)) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    appendFileSync(absPath, content, 'utf-8');

    // Re-index
    await this.indexFile(nodeId);
  }

  async addLink(sourceId: string, targetRef: string, context: string): Promise<void> {
    const absPath = join(this.vaultPath, sourceId);
    assertPathInVault(absPath, this.vaultPath, sourceId);
    if (!existsSync(absPath)) {
      throw new Error(`Source node not found: ${sourceId}`);
    }

    // Both fields reach this method from MCP tool input (LLM-controlled).
    // Reject anything that would corrupt the appended line — bracket
    // characters in the target or newlines in either field.
    if (!targetRef || INVALID_LINK_TARGET_CHARS.test(targetRef)) {
      throw new Error(
        `Unsafe link target: ${JSON.stringify(targetRef)} — contains bracket, pipe, or control character`,
      );
    }
    if (INVALID_LINK_CONTEXT_CHARS.test(context)) {
      throw new Error(
        'Unsafe link context: contains bracket, pipe, newline, or control character ' +
        '(addLink creates exactly one link; use annotateNode for arbitrary markdown)',
      );
    }

    const line = `\n${context} [[${targetRef}]]`;
    appendFileSync(absPath, line, 'utf-8');

    // Re-index source node
    await this.indexFile(sourceId);

    // Resolve target to actual node ID. Unknown targets must use the same
    // `_stub/` prefix the parser uses (parser.ts emits `_stub/<name>.md`),
    // so the IndexPipeline reconciliation pass can later rewrite them to
    // real edges when the target file is created. Without the prefix,
    // the resulting edge points at a node ID that doesn't exist in the
    // node table; KnowledgeGraph.fromStore filters those edges out and
    // the link is invisible to graph traversal until the next reparse.
    const matches = resolveNodeName(targetRef, this.store);
    let targetId: string;
    if (matches.length > 0) {
      targetId = matches[0].nodeId;
    } else {
      // Mirror parser semantics EXACTLY: parser.ts emits `_stub/${raw}.md`
      // UNCONDITIONALLY for an unresolved `[[raw]]` — even when raw already
      // ends in `.md` (the literal `[[Foo.md]]` re-parses to
      // `_stub/Foo.md.md`). Minting a different ID here made the next
      // IndexPipeline run misclassify the writer's stub as resolved: it
      // deleted it, rewrote the source's edges, and re-created the
      // parser-shaped stub — phantom stub churn on every full index.
      targetId = `_stub/${targetRef}.md`;
      // Materialize the stub node so KnowledgeGraph.fromStore includes the
      // edge in adjacency builds. Mirrors IndexPipeline's stub creation
      // (whose title rule — strip prefix + first '.md' — yields targetRef).
      if (!this.store.getNode(targetId)) {
        this.store.upsertNode({
          id: targetId,
          title: targetRef,
          content: '',
          frontmatter: { _stub: true },
        });
      }
    }
    this.store.insertEdge({
      sourceId,
      targetId,
      context,
    });
  }

  private async indexFile(relPath: string): Promise<void> {
    const absPath = join(this.vaultPath, relPath);
    assertPathInVault(absPath, this.vaultPath, relPath);
    const raw = readFileSync(absPath, 'utf-8');

    let fm: Record<string, unknown>;
    let content: string;
    try {
      const parsed = matter(raw);
      // Strip prototype-pollution keys before passing frontmatter to the
      // store. The parser path applies the same guard (parser.ts) — this
      // re-index path used to bypass it (Codex review #10), letting any
      // file edited or appended-to via writer methods land __proto__ /
      // constructor / prototype keys in the store and downstream spreads.
      fm = sanitizeFrontmatter(parsed.data);
      content = parsed.content;
    } catch {
      fm = {};
      content = raw;
    }

    // Mirror parser.ts: non-string/blank `title:` falls back to the filename
    // (better-sqlite3 cannot bind an array/object title in upsertNode).
    const title = typeof fm.title === 'string' && fm.title.trim()
      ? fm.title
      : basename(relPath, '.md');

    this.store.upsertNode({
      id: relPath,
      title,
      content,
      frontmatter: fm,
    });

    // Compute + store the embedding so the node is immediately returnable by
    // semantic search (kg_search's default mode). Mirrors IndexPipeline's
    // embedding path: same buildEmbeddingText(title, tags, content) input.
    if (this.embedder) {
      const tags = Array.isArray(fm.tags)
        ? (fm.tags as unknown[]).filter((t): t is string => typeof t === 'string')
        : [];
      const text = Embedder.buildEmbeddingText(title, tags, content);
      const embedding = await this.embedder.embed(text);
      this.store.upsertEmbedding(relPath, embedding);
    }
  }
}
