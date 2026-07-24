import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  openSync,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  statSync,
  constants,
} from 'fs';
import { join, basename, dirname, resolve } from 'path';
import matter from 'gray-matter';
import type { Store } from './store.js';
import { Embedder } from './embedder.js';
import { resolveNodeName } from './resolve.js';
import { buildStemLookup, resolveLink } from './wiki-links.js';
import { sanitizeFrontmatter, EXCLUDED_DIRS } from './parser.js';

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
  // The filename is `${title}.md`; collectMarkdownFiles skips any entry whose
  // name starts with '.', so a dot-prefixed title is parser-invisible and the
  // node would be deleted on the next index (finding writer.ts:62).
  if (title.startsWith('.')) {
    throw new Error(
      `Unsafe title: ${JSON.stringify(title)} — leading-dot files are skipped by the indexer ` +
      `and the node would be deleted on the next index`,
    );
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
    // collectMarkdownFiles skips dot-prefixed and EXCLUDED_DIRS directories, so
    // a node written under one is parser-invisible and gets deleted on the next
    // index. Reject those segments here rather than silently creating a doomed
    // node (finding writer.ts:62).
    if (seg.startsWith('.') || EXCLUDED_DIRS.has(seg)) {
      throw new Error(
        `Unsafe directory segment ${JSON.stringify(seg)}: the indexer skips dot-prefixed and ` +
        `excluded directories (${[...EXCLUDED_DIRS].join(', ')}), so the node would be deleted on the next index`,
      );
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

/**
 * Throws if creating directory `dir` (via mkdirSync recursive) would escape the
 * vault through a symlinked ancestor. Canonicalizes the DEEPEST EXISTING
 * ancestor of `dir` — mkdirSync(recursive) follows an existing in-vault symlink
 * (e.g. `linked` -> /outside) and would materialize the remaining segments
 * OUTSIDE the vault. assertPathInVault run afterwards only fires AFTER those
 * external directories already exist (finding writer.ts:138), so this check must
 * run BEFORE mkdirSync. New (not-yet-existing) leaf segments cannot be symlinks,
 * so canonicalizing the existing prefix is sufficient.
 */
function assertDirCreationInVault(dir: string, vaultPath: string, nodeId: string): void {
  const realVault = realpathSync(vaultPath);
  // Canonicalize the deepest EXISTING ancestor of `dir`. realpathSync throws
  // ENOENT for a not-yet-existing path, so walk up until it resolves — this
  // follows any symlink in the existing prefix. We probe with realpathSync
  // (not existsSync) so a global fs.existsSync mock — used elsewhere in the
  // test suite to drive the createNode race — cannot perturb the walk.
  let ancestor = dir;
  let realAncestor: string;
  for (;;) {
    try {
      realAncestor = realpathSync(ancestor);
      break;
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        realAncestor = parent;
        break;
      }
      ancestor = parent;
    }
  }
  if (!realAncestor.startsWith(realVault + '/') && realAncestor !== realVault) {
    throw new Error(`Node ID escapes vault: ${nodeId}`);
  }
}

/**
 * Append through an identity-checked descriptor. The path is untrusted between
 * every filesystem call: a sync client or another process can replace the
 * checked file with a symlink or different inode before appendFileSync reopens
 * it. O_NOFOLLOW protects the final component, while pre/open/post inode checks
 * reject regular-file replacement and a second boundary check catches ancestor
 * changes before any bytes are written.
 */
function appendFileInVault(
  absPath: string,
  vaultPath: string,
  nodeId: string,
  content: string,
): void {
  const before = lstatSync(absPath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`Unsafe node path changed before append: ${nodeId}`);
  }

  const flags = constants.O_WRONLY
    | constants.O_APPEND
    | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(absPath, flags);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) {
      throw new Error(`Node path changed during append: ${nodeId}`);
    }

    assertPathInVault(absPath, vaultPath, nodeId);
    const currentLink = lstatSync(absPath);
    const current = statSync(absPath);
    if (
      currentLink.isSymbolicLink()
      || current.dev !== opened.dev
      || current.ino !== opened.ino
    ) {
      throw new Error(`Node path changed during append: ${nodeId}`);
    }

    writeFileSync(fd, content, 'utf-8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
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
    // Boundary check BEFORE mkdirSync (finding writer.ts:138): a recursive mkdir
    // follows an in-vault symlinked ancestor and would create attacker/LLM-chosen
    // directory trees OUTSIDE the vault before the post-write guard below fires.
    assertDirCreationInVault(dir, this.vaultPath, opts.directory ?? '.');
    mkdirSync(dir, { recursive: true });

    const filename = `${opts.title}.md`;
    const relPath = opts.directory ? `${opts.directory}/${filename}` : filename;
    const absPath = join(dir, filename);

    // Vault-boundary check BEFORE any write. assertSafeDirectory above is
    // lexical only (blocks '..'/absolute/reserved chars, NOT symlinks); an
    // in-vault symlinked directory would otherwise let writeFileSync+renameSync
    // materialize attacker/LLM-controlled content OUTSIDE the vault, only for
    // indexFile's guard to fire AFTER the file already exists on disk (finding
    // writer.ts:160). The dir now exists (mkdirSync ran), so the realpathSync
    // fallback resolves the symlink and throws before we touch the filesystem.
    assertPathInVault(absPath, this.vaultPath, relPath);

    if (existsSync(absPath)) {
      throw new Error(`File already exists: ${relPath}`);
    }

    const fm = { title: opts.title, ...opts.frontmatter };
    const fileContent = matter.stringify(opts.content, fm);

    // Publish through an exclusively-created final-path fd. O_EXCL closes the
    // check-then-act race without re-resolving a mutable temp pathname (link(2)
    // does), and O_NOFOLLOW rejects a destination symlink. A failed write may
    // leave an incomplete, identity-owned file for explicit recovery; we never
    // unlink by pathname after failure because a concurrent writer may already
    // have replaced that entry.
    try {
      const flags = constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0);
      const fd = openSync(absPath, flags, 0o666);
      try {
        const fdStat = fstatSync(fd);
        const opened = { dev: fdStat.dev, ino: fdStat.ino };
        writeFileSync(fd, fileContent, 'utf-8');
        fsyncSync(fd);

        // Keep the descriptor open while validating the pathname. If another
        // writer unlinks our entry, the open fd pins its inode so a replacement
        // cannot immediately reuse the same dev/ino pair and evade this check.
        const published = lstatSync(absPath);
        if (
          published.isSymbolicLink()
          || published.dev !== opened.dev
          || published.ino !== opened.ino
        ) {
          throw new Error(`Node path changed during create: ${relPath}`);
        }
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`File already exists: ${relPath}`);
      }
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

    appendFileInVault(absPath, this.vaultPath, nodeId, content);

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

    // Resolve target to actual node ID. Unknown targets must use the same
    // `_stub/` prefix the parser uses (parser.ts emits `_stub/<name>.md`),
    // so the IndexPipeline reconciliation pass can later rewrite them to
    // real edges when the target file is created. Without the prefix,
    // the resulting edge points at a node ID that doesn't exist in the
    // node table; KnowledgeGraph.fromStore filters those edges out and
    // the link is invisible to graph traversal until the next reparse.
    const matches = resolveNodeName(targetRef, this.store);
    let targetId: string;
    // Text written inside [[ ]]. Defaults to the caller's raw ref so the
    // common case keeps a human-readable `[[Title]]`.
    let linkRef = targetRef;
    // A match against an already-existing STUB node (`_stub/` prefix) must be
    // treated as UNRESOLVED, not resolved. A stub is not a real vault file, so
    // the reparse guard's resolveLink (which only knows real files) can never
    // re-resolve to it — the guard would always fire and rewrite the readable
    // `[[Target]]` into the internal `[[_stub/Target]]` form. That literal then
    // re-parses on the next full index to a DIFFERENT double-nested stub
    // (`_stub/_stub/Target.md`), silently fragmenting repeated links to the
    // same not-yet-created topic (finding writer.ts:218). Routing stub matches
    // through the else branch mints the parser-shaped `_stub/<ref>.md` id
    // (idempotent with the first call) and keeps the link text readable.
    // Prefer the first NON-stub match rather than only inspecting matches[0].
    // resolveNodeName's exact-title pass returns ALL same-title rows in rowid
    // order with no stub de-prioritization, so a stub minted before a later
    // real note (the normal timeline) sorted first and silently captured the
    // edge. Falling back to null only when NO real node matches preserves the
    // pinned first-match behavior for all-real ambiguity (finding writer.ts:230).
    const resolved = matches.find(m => !m.nodeId.startsWith('_stub/')) ?? null;
    if (resolved) {
      targetId = resolved.nodeId;
      // resolveNodeName matches by id/title/alias/substring, but a subsequent
      // full `kg index` re-resolves the SAME written link with resolveLink,
      // which matches ONLY by filename stem or path. For any note whose
      // title/alias differs from its filename stem (a common Obsidian pattern:
      // stem `wt`, title `Widget Theory`) the two disagree — the link written
      // as the raw title resolves HERE to the real node but re-resolves on the
      // next index to `_stub/<title>.md`, silently retargeting the edge to a
      // phantom stub and orphaning the real node's backlink (finding
      // writer.ts:218). Guard: if the raw ref would NOT re-resolve to this same
      // node, write a path-qualified link (`<id without .md>`) that resolveLink
      // maps back exactly. Only rewrites in the mismatch case, so stem==title
      // links keep their readable `[[Title]]` form.
      //
      // Skip the guard for priority-0 (id) matches: an id match means
      // targetRef (normalized to +`.md`) already equals targetId, and
      // resolveLink resolves that same ref by direct-path lookup to the same
      // id — so reparseTarget === targetId always and the O(N) allNodeIds()
      // scan is vacuous. Only title/alias/substring matches can disagree with
      // the stem-based reparse and need the scan (finding writer.ts:232).
      if (resolved.matchType !== 'id') {
        const realPaths = this.store.allNodeIds().filter(id => !id.startsWith('_stub/'));
        const reparseTarget = resolveLink(targetRef, buildStemLookup(realPaths));
        if (reparseTarget !== targetId) {
          linkRef = targetId.replace(/\.md$/, '');
        }
      }
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

    // Append the (possibly path-qualified) wiki link now that linkRef is
    // known, then re-index the source node so its record/embedding reflect
    // the new content.
    const line = `\n${context} [[${linkRef}]]`;
    appendFileInVault(absPath, this.vaultPath, sourceId, line);
    await this.indexFile(sourceId);

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
