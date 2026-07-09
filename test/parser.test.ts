import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseVault, truncateCodepoints } from '../src/lib/parser.js';

const FIXTURE_VAULT = join(import.meta.dirname, 'fixtures', 'vault');

describe('parseVault', () => {
  it('finds all .md files and skips excluded directories', async () => {
    const { nodes } = await parseVault(FIXTURE_VAULT);
    const ids = nodes.map(n => n.id);
    expect(ids).toContain('People/Alice Smith.md');
    expect(ids).toContain('People/Bob Jones.md');
    expect(ids).toContain('Concepts/Widget Theory.md');
    expect(ids).toContain('orphan.md');
    // Should NOT include .obsidian or attachments
    expect(ids.every(id => !id.startsWith('.obsidian/'))).toBe(true);
    expect(ids.every(id => !id.startsWith('attachments/'))).toBe(true);
  });

  it('parses frontmatter correctly', async () => {
    const { nodes } = await parseVault(FIXTURE_VAULT);
    const alice = nodes.find(n => n.id === 'People/Alice Smith.md')!;
    expect(alice.title).toBe('Alice Smith');
    expect(alice.frontmatter.type).toBe('person');
    expect(alice.frontmatter.aliases).toContain('A. Smith');
  });

  it('falls back to filename when no title in frontmatter', async () => {
    const { nodes } = await parseVault(FIXTURE_VAULT);
    const noTitle = nodes.find(n => n.id === 'no-title.md')!;
    expect(noTitle.title).toBe('no-title');
  });

  it('extracts resolved edges with context', async () => {
    const { edges } = await parseVault(FIXTURE_VAULT);
    const aliceToWidget = edges.find(
      e => e.sourceId === 'People/Alice Smith.md'
        && e.targetId === 'Concepts/Widget Theory.md'
    );
    expect(aliceToWidget).toBeDefined();
    expect(aliceToWidget!.context).toContain('Widget Theory');
  });

  it('creates stub edges for nonexistent targets', async () => {
    const { edges, stubIds } = await parseVault(FIXTURE_VAULT);
    const stubEdge = edges.find(e => e.targetId.includes('Nonexistent Page'));
    expect(stubEdge).toBeDefined();
    expect(stubIds.size).toBeGreaterThan(0);
  });

  it('extracts inline tags', async () => {
    const { nodes } = await parseVault(FIXTURE_VAULT);
    const bob = nodes.find(n => n.id === 'People/Bob Jones.md')!;
    expect(bob.frontmatter.inline_tags).toContain('research');
    expect(bob.frontmatter.inline_tags).toContain('published');
  });

  // Regression (finding parser.ts:119): the old ASCII-only pattern
  // (`#[a-zA-Z][\w-\/]*`, no /u) silently dropped every non-ASCII inline tag.
  // For this vault's zh-TW content that is a systematic loss of tag metadata.
  // The Unicode-aware \p{L} + /u pattern must capture CJK / accented tags while
  // still extracting the ASCII tags alongside them.
  it('extracts non-ASCII (CJK / accented) inline tags', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-parser-cjk-tags-'));
    try {
      writeFileSync(
        join(tmpVault, 'zh.md'),
        '在筆記中 #專案管理 和 #research 還有 #日本語 以及巢狀 #領域/子題 和 #café\n',
        'utf-8',
      );
      const { nodes } = await parseVault(tmpVault);
      const tags = nodes.find(n => n.id === 'zh.md')!.frontmatter.inline_tags as string[];
      expect(tags).toContain('專案管理');
      expect(tags).toContain('research');
      expect(tags).toContain('日本語');
      expect(tags).toContain('領域/子題');
      expect(tags).toContain('café');
    } finally {
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  // Regression (finding parser.ts:86): edge context is truncated with a
  // fixed-length cut and PERSISTED to the DB. A plain .slice() counts UTF-16
  // code units, so an astral char (emoji) straddling the 500-char boundary was
  // split into a lone surrogate and stored as invalid Unicode. The cut must
  // land on a codepoint boundary instead.
  it('truncates edge context on a codepoint boundary (no split astral char)', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-parser-astral-'));
    try {
      // 499 BMP chars, then an emoji straddling index 499/500, inside a single
      // no-blank-line paragraph that also contains a wikilink → one edge whose
      // context is truncated at 500.
      const body = 'a'.repeat(499) + '🔥' + 'b'.repeat(50) + ' [[Target]] tail';
      writeFileSync(join(tmpVault, 'src.md'), body + '\n', 'utf-8');
      const { edges } = await parseVault(tmpVault);
      const edge = edges.find(e => e.sourceId === 'src.md')!;
      expect(edge).toBeDefined();
      // The 500th codepoint is the emoji; it must be kept whole, not split.
      // Buggy slice(0,500) would end with a lone high surrogate (\uD83D) and
      // NOT contain the full '🔥'.
      expect(edge.context.endsWith('🔥')).toBe(true);
      expect(edge.context.includes('\uD83D') && !edge.context.includes('🔥')).toBe(false);
    } finally {
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  it('truncateCodepoints does not split a surrogate pair at the boundary', () => {
    // 3 BMP chars + emoji (2 code units). slice(0,4) would keep the high
    // surrogate only; truncateCodepoints must drop the whole emoji.
    const s = 'abc🔥xyz';
    expect(truncateCodepoints(s, 4)).toBe('abc🔥');
    expect(truncateCodepoints(s, 3)).toBe('abc');
    // Plain slice would corrupt: prove the helper differs from the buggy path.
    expect(s.slice(0, 4)).toBe('abc\uD83D'); // lone high surrogate (the bug)
    expect([...truncateCodepoints(s, 4)].every(c => c.codePointAt(0)! <= 0x10FFFF)).toBe(true);
    // Shorter than limit → unchanged.
    expect(truncateCodepoints('hi', 10)).toBe('hi');
  });

  // Regression (finding wiki-links.ts:68): [[Note#Heading]] to an EXISTING note
  // must produce an edge to that note, not a phantom _stub/Note#Heading.md.
  it('resolves anchored links to the real note instead of minting a stub', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-parser-anchor-'));
    try {
      writeFileSync(join(tmpVault, 'Target.md'), '# Target\n\n# Overview\n\nbody\n', 'utf-8');
      writeFileSync(
        join(tmpVault, 'Src.md'),
        'See [[Target#Overview]] and [[Target#Overview|the overview]].\n',
        'utf-8',
      );
      const { edges, stubIds } = await parseVault(tmpVault);
      const srcEdges = edges.filter(e => e.sourceId === 'Src.md');
      expect(srcEdges.length).toBe(2);
      expect(srcEdges.every(e => e.targetId === 'Target.md')).toBe(true);
      // No phantom stub carrying the anchor text.
      expect([...stubIds].some(id => id.includes('#'))).toBe(false);
    } finally {
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  // Regression (finding wiki-links.ts:68): an UNRESOLVABLE anchored link must
  // mint its stub from the file part, not the full raw text with the anchor.
  it('mints an unresolved anchored stub from the file part only', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-parser-anchor-stub-'));
    try {
      writeFileSync(join(tmpVault, 'Src.md'), 'See [[Missing#Section]].\n', 'utf-8');
      const { stubIds } = await parseVault(tmpVault);
      expect(stubIds.has('_stub/Missing.md')).toBe(true);
      expect(stubIds.has('_stub/Missing#Section.md')).toBe(false);
    } finally {
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  // Regression (finding parser.ts:103): the edge-context paragraph lookup
  // matched on the OPEN prefix `[[raw`, so a link whose name is a prefix of
  // another linked note's name (e.g. [[Foo]] vs [[Foobar]]) captured the wrong
  // paragraph as context. The match must close against the link's terminators.
  it('stores the paragraph containing the actual link, not a prefix collision', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-parser-prefix-'));
    try {
      writeFileSync(join(tmpVault, 'Foo.md'), '# Foo\n', 'utf-8');
      writeFileSync(join(tmpVault, 'Foobar.md'), '# Foobar\n', 'utf-8');
      writeFileSync(
        join(tmpVault, 'Note.md'),
        'Discussion of [[Foobar]] in the first paragraph.\n\n' +
          'The real link to [[Foo]] appears only here in the second paragraph.\n',
        'utf-8',
      );
      const { edges } = await parseVault(tmpVault);
      const fooEdge = edges.find(e => e.sourceId === 'Note.md' && e.targetId === 'Foo.md')!;
      expect(fooEdge).toBeDefined();
      expect(fooEdge.context).toContain('second paragraph');
      expect(fooEdge.context).not.toContain('Foobar');
    } finally {
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  it('handles malformed frontmatter gracefully', async () => {
    const { nodes } = await parseVault(FIXTURE_VAULT);
    const bad = nodes.find(n => n.id === 'bad-frontmatter.md')!;
    expect(bad).toBeDefined();
    // Falls back to filename as title
    expect(bad.title).toBe('bad-frontmatter');
    // Content should contain the raw file content
    expect(bad.content).toContain('Bad Frontmatter');
  });

  // Regression: `title:` frontmatter is user-authored YAML and can be an
  // array / number / empty string. The unguarded `fm.title as string` let a
  // non-string flow into Store.upsertNode, where better-sqlite3 cannot bind
  // it — ONE malformed note aborted the entire pipeline.index() run mid-way
  // (partial DB state, stale communities). The suite already guards the
  // identical failure class for `tags:` (graph.test.ts) and `aliases:`
  // (resolve.test.ts) but missed `title:`. Non-string titles must fall back
  // to the filename, exactly like a missing title does.
  it('falls back to filename when title frontmatter is not a string', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-parser-title-'));
    try {
      writeFileSync(
        join(tmpVault, 'array-title.md'),
        '---\ntitle:\n  - part1\n  - part2\n---\nbody\n',
        'utf-8',
      );
      writeFileSync(join(tmpVault, 'number-title.md'), '---\ntitle: 42\n---\nbody\n', 'utf-8');
      writeFileSync(join(tmpVault, 'null-title.md'), '---\ntitle:\n---\nbody\n', 'utf-8');
      writeFileSync(join(tmpVault, 'blank-title.md'), '---\ntitle: ""\n---\nbody\n', 'utf-8');

      const { nodes } = await parseVault(tmpVault);
      expect(nodes.find(n => n.id === 'array-title.md')!.title).toBe('array-title');
      expect(nodes.find(n => n.id === 'number-title.md')!.title).toBe('number-title');
      expect(nodes.find(n => n.id === 'null-title.md')!.title).toBe('null-title');
      expect(nodes.find(n => n.id === 'blank-title.md')!.title).toBe('blank-title');
    } finally {
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  // Regression (finding parser.ts:59): extractInlineTags ran on the RAW note
  // content, while extractWikiLinks deliberately strips fenced/inline code
  // first. The tag pattern matched inside code fences, so a ```c block with
  // `#include <stdio.h>` minted a phantom `include` tag (and CSS `#ff0000`
  // minted `ff0000`). Code must be stripped before tag extraction, mirroring
  // the wiki-link path.
  it('does not extract inline tags from inside code fences', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-parser-codetags-'));
    try {
      writeFileSync(
        join(tmpVault, 'code.md'),
        'Intro with a real #project tag.\n\n' +
          '```c\n#include <stdio.h>\nint main(){ return 0; }\n```\n\n' +
          'Inline `#ff0000` color and `#notatag` here.\n',
        'utf-8',
      );
      const { nodes } = await parseVault(tmpVault);
      const tags = nodes.find(n => n.id === 'code.md')!.frontmatter.inline_tags as string[];
      // Only the real tag outside code survives.
      expect(tags).toEqual(['project']);
      // Explicitly: the code-block false positives must be absent.
      expect(tags).not.toContain('include');
      expect(tags).not.toContain('ff0000');
      expect(tags).not.toContain('notatag');
    } finally {
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  // Regression: YAML frontmatter is user-authored. A payload like
  // `__proto__: { polluted: true }` would flow through Store.upsertNode and
  // downstream object-spread sites, mutating Object.prototype for the whole
  // process. sanitizeFrontmatter drops the three dangerous keys.
  it('strips prototype-pollution keys from frontmatter', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-parser-proto-'));
    try {
      writeFileSync(
        join(tmpVault, 'evil.md'),
        '---\n__proto__:\n  polluted: true\nconstructor:\n  evil: 1\nprototype:\n  x: 1\ntitle: Evil\n---\nbody\n',
        'utf-8',
      );
      const { nodes } = await parseVault(tmpVault);
      const evil = nodes.find(n => n.id === 'evil.md')!;
      expect(evil).toBeDefined();
      expect(evil.title).toBe('Evil');
      expect(Object.prototype.hasOwnProperty.call(evil.frontmatter, '__proto__')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(evil.frontmatter, 'constructor')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(evil.frontmatter, 'prototype')).toBe(false);
      // Crucially, Object.prototype is not polluted.
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    } finally {
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });
});
