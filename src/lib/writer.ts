import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join, basename } from 'path';
import matter from 'gray-matter';
import type { Store } from './store.js';
import { resolveNodeName } from './resolve.js';

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
    if (INVALID_TITLE_CHARS.test(seg.replace('/', ''))) {
      throw new Error(`Unsafe directory segment: ${JSON.stringify(seg)}`);
    }
  }
}

export class VaultWriter {
  constructor(
    private vaultPath: string,
    private store: Store,
  ) {}

  createNode(opts: CreateNodeOptions): string {
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
    writeFileSync(absPath, fileContent, 'utf-8');

    // Index in store
    this.indexFile(relPath);

    return relPath;
  }

  annotateNode(nodeId: string, content: string): void {
    const absPath = join(this.vaultPath, nodeId);
    if (!existsSync(absPath)) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    appendFileSync(absPath, content, 'utf-8');

    // Re-index
    this.indexFile(nodeId);
  }

  addLink(sourceId: string, targetRef: string, context: string): void {
    const absPath = join(this.vaultPath, sourceId);
    if (!existsSync(absPath)) {
      throw new Error(`Source node not found: ${sourceId}`);
    }

    const line = `\n${context} [[${targetRef}]]`;
    appendFileSync(absPath, line, 'utf-8');

    // Re-index source node
    this.indexFile(sourceId);

    // Resolve target to actual node ID, fall back to naive .md append for stubs
    const matches = resolveNodeName(targetRef, this.store);
    const targetId = matches.length > 0
      ? matches[0].nodeId
      : (targetRef.endsWith('.md') ? targetRef : targetRef + '.md');
    this.store.insertEdge({
      sourceId,
      targetId,
      context,
    });
  }

  private indexFile(relPath: string): void {
    const absPath = join(this.vaultPath, relPath);
    const raw = readFileSync(absPath, 'utf-8');

    let fm: Record<string, unknown>;
    let content: string;
    try {
      const parsed = matter(raw);
      fm = parsed.data;
      content = parsed.content;
    } catch {
      fm = {};
      content = raw;
    }

    const title = (fm.title as string) ?? basename(relPath, '.md');

    this.store.upsertNode({
      id: relPath,
      title,
      content,
      frontmatter: fm,
    });
  }
}
