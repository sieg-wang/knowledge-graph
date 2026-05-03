import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { cpSync } from 'fs';
import { VaultWriter } from '../src/lib/writer.js';
import { Store } from '../src/lib/store.js';

const FIXTURE_VAULT = join(import.meta.dirname, 'fixtures', 'vault');

describe('VaultWriter', () => {
  let tempVault: string;
  let store: Store;
  let writer: VaultWriter;

  beforeEach(() => {
    tempVault = mkdtempSync(join(tmpdir(), 'kg-writer-'));
    cpSync(FIXTURE_VAULT, tempVault, { recursive: true });
    store = new Store(':memory:');
    writer = new VaultWriter(tempVault, store);
  });

  afterEach(() => {
    store.close();
  });

  describe('createNode', () => {
    it('creates a new markdown file with frontmatter', () => {
      writer.createNode({
        title: 'New Concept',
        directory: 'Concepts',
        frontmatter: { type: 'concept', tags: ['test'] },
        content: 'This is a new concept about testing.',
      });

      const filePath = join(tempVault, 'Concepts', 'New Concept.md');
      expect(existsSync(filePath)).toBe(true);

      const raw = readFileSync(filePath, 'utf-8');
      expect(raw).toContain('title: New Concept');
      expect(raw).toContain('type: concept');
      expect(raw).toContain('This is a new concept about testing.');
    });

    it('indexes the new node in the store', () => {
      writer.createNode({
        title: 'New Concept',
        directory: 'Concepts',
        frontmatter: { type: 'concept' },
        content: 'A test concept.',
      });

      const node = store.getNode('Concepts/New Concept.md');
      expect(node).toBeDefined();
      expect(node!.title).toBe('New Concept');
    });

    it('creates directories that do not exist', () => {
      writer.createNode({
        title: 'Fresh Note',
        directory: 'NewDir',
        frontmatter: {},
        content: 'In a new directory.',
      });

      const filePath = join(tempVault, 'NewDir', 'Fresh Note.md');
      expect(existsSync(filePath)).toBe(true);
    });

    it('creates at vault root when no directory specified', () => {
      writer.createNode({
        title: 'Root Note',
        frontmatter: {},
        content: 'At the root.',
      });

      const filePath = join(tempVault, 'Root Note.md');
      expect(existsSync(filePath)).toBe(true);
    });

    it('throws if the file already exists', () => {
      expect(() => writer.createNode({
        title: 'Alice Smith',
        directory: 'People',
        frontmatter: {},
        content: 'Duplicate.',
      })).toThrow(/already exists/);
    });

    // Regression: title comes from LLM/CLI input. Previously a title of
    // `../../etc/passwd` or `Foo/Bar` silently wrote outside the vault or
    // into an unintended subdirectory.
    it('rejects a title with a forward slash', () => {
      expect(() => writer.createNode({
        title: 'foo/bar',
        frontmatter: {},
        content: 'x',
      })).toThrow(/Unsafe title/);
    });

    it('rejects a title with a backslash', () => {
      expect(() => writer.createNode({
        title: 'foo\\bar',
        frontmatter: {},
        content: 'x',
      })).toThrow(/Unsafe title/);
    });

    it('rejects a title equal to ".." (parent directory)', () => {
      expect(() => writer.createNode({
        title: '..',
        frontmatter: {},
        content: 'x',
      })).toThrow(/Unsafe title/);
    });

    it('rejects a title with control characters', () => {
      expect(() => writer.createNode({
        title: 'foo\x00bar',
        frontmatter: {},
        content: 'x',
      })).toThrow(/Unsafe title/);
    });

    it('rejects an empty title', () => {
      expect(() => writer.createNode({
        title: '',
        frontmatter: {},
        content: 'x',
      })).toThrow(/Unsafe title/);
    });

    it('rejects a directory containing "../"', () => {
      expect(() => writer.createNode({
        title: 'Ok',
        directory: '../escape',
        frontmatter: {},
        content: 'x',
      })).toThrow(/Unsafe directory/);
    });

    it('rejects an absolute directory', () => {
      expect(() => writer.createNode({
        title: 'Ok',
        directory: '/etc',
        frontmatter: {},
        content: 'x',
      })).toThrow(/Unsafe directory/);
    });

    it('still accepts a nested directory path without parent refs', () => {
      writer.createNode({
        title: 'Inside',
        directory: 'a/b/c',
        frontmatter: {},
        content: 'nested ok',
      });
      expect(existsSync(join(tempVault, 'a', 'b', 'c', 'Inside.md'))).toBe(true);
    });

    // Regression: createNode previously called writeFileSync directly, so a
    // crash mid-write would leave a partially-written <title>.md behind that
    // the next IndexPipeline pass would treat as a real, corrupt node. The
    // fix is a tmp-file + rename publish (POSIX-atomic on the same fs).
    it('publishes via tmp+rename so no partial file is left under the final name', () => {
      const dir = join(tempVault, 'Concepts');
      const before = readdirSync(dir);

      writer.createNode({
        title: 'Atomic Concept',
        directory: 'Concepts',
        frontmatter: { type: 'concept' },
        content: 'Body.',
      });

      const after = readdirSync(dir);
      // Expected new file is present.
      expect(after).toContain('Atomic Concept.md');
      // No leftover .tmp.* sibling from the publish.
      const leftover = after.filter(
        (n) => !before.includes(n) && n.startsWith('Atomic Concept.md.tmp.'),
      );
      expect(leftover).toEqual([]);
    });

  });

  describe('annotateNode', () => {
    it('appends content to an existing file', () => {
      writer.annotateNode('People/Alice Smith.md', '\n## Agent Notes\nAlice is a key connector.');

      const raw = readFileSync(join(tempVault, 'People', 'Alice Smith.md'), 'utf-8');
      expect(raw).toContain('## Agent Notes');
      expect(raw).toContain('Alice is a key connector.');
    });

    it('re-indexes the node in the store after annotation', () => {
      // First index the original
      writer.createNode({
        title: 'Temp Note',
        frontmatter: {},
        content: 'Original content.',
      });
      const before = store.getNode('Temp Note.md');
      expect(before!.content).toContain('Original content.');

      writer.annotateNode('Temp Note.md', '\n\nAppended content.');
      const after = store.getNode('Temp Note.md');
      expect(after!.content).toContain('Appended content.');
    });

    it('throws if the node does not exist', () => {
      expect(() => writer.annotateNode('nonexistent.md', 'stuff')).toThrow(/not found/);
    });
  });

  describe('addLink', () => {
    it('appends a wiki link to the source file', () => {
      writer.createNode({
        title: 'Source',
        frontmatter: {},
        content: 'Some content.',
      });

      writer.addLink('Source.md', 'People/Alice Smith', 'Related to Alice.');

      const raw = readFileSync(join(tempVault, 'Source.md'), 'utf-8');
      expect(raw).toContain('[[People/Alice Smith]]');
      expect(raw).toContain('Related to Alice.');
    });

    it('creates an edge in the store', () => {
      writer.createNode({
        title: 'Source',
        frontmatter: {},
        content: 'Some content.',
      });

      writer.addLink('Source.md', 'People/Alice Smith', 'Related to Alice.');

      // Unknown targets now route through the parser-compatible `_stub/`
      // prefix so IndexPipeline.reconciliation can later rewrite the edge
      // when the real file appears. Previous behavior wrote bare
      // "People/Alice Smith.md" — graph-invisible until next reparse.
      const edges = store.getEdgesFrom('Source.md');
      expect(edges.some(e => e.targetId === '_stub/People/Alice Smith.md')).toBe(true);
    });

    it('resolves target by title to full node ID', () => {
      writer.createNode({
        title: 'Source',
        frontmatter: {},
        content: 'Some content.',
      });
      // Pre-seed the target in the store (fixture already has the file on disk)
      store.upsertNode({
        id: 'Concepts/Widget Theory.md',
        title: 'Widget Theory',
        content: 'A concept.',
        frontmatter: {},
      });

      // Link by title only — should resolve to "Concepts/Widget Theory.md"
      writer.addLink('Source.md', 'Widget Theory', 'Uses widget theory.');

      const edges = store.getEdgesFrom('Source.md');
      expect(edges.some(e => e.targetId === 'Concepts/Widget Theory.md')).toBe(true);
    });

    it('uses _stub/ prefix for unknown targets (matches parser semantics)', () => {
      writer.createNode({
        title: 'Source',
        frontmatter: {},
        content: 'Some content.',
      });

      writer.addLink('Source.md', 'Unknown Target', 'Linked to unknown.');

      const edges = store.getEdgesFrom('Source.md');
      expect(edges.some(e => e.targetId === '_stub/Unknown Target.md')).toBe(true);

      // Stub node is materialized so KnowledgeGraph.fromStore includes the
      // edge in adjacency builds (without this, the link is invisible to
      // graph traversal until the next full reparse).
      expect(store.getNode('_stub/Unknown Target.md')).toBeDefined();
    });

    it('preserves .md extension when constructing stub ID for unknown targets', () => {
      writer.createNode({
        title: 'Source',
        frontmatter: {},
        content: 'Some content.',
      });

      writer.addLink('Source.md', 'Unknown.md', 'Link context.');

      const edges = store.getEdgesFrom('Source.md');
      expect(edges.some(e => e.targetId === '_stub/Unknown.md')).toBe(true);
      expect(store.getNode('_stub/Unknown.md')).toBeDefined();
    });

    it('does NOT use _stub/ prefix when target resolves to an existing node', () => {
      writer.createNode({
        title: 'Source',
        frontmatter: {},
        content: 'Some content.',
      });
      store.upsertNode({
        id: 'People/Bob.md',
        title: 'Bob',
        content: '',
        frontmatter: {},
      });

      writer.addLink('Source.md', 'Bob', 'Hi Bob.');

      const edges = store.getEdgesFrom('Source.md');
      // Resolved targets bypass the stub prefix entirely.
      expect(edges.some(e => e.targetId === 'People/Bob.md')).toBe(true);
      expect(edges.some(e => e.targetId.startsWith('_stub/'))).toBe(false);
    });

    it('picks first match when target resolves ambiguously', () => {
      writer.createNode({
        title: 'Source',
        frontmatter: {},
        content: 'Some content.',
      });
      store.upsertNode({ id: 'a.md', title: 'Alpha Smith', content: '', frontmatter: {} });
      store.upsertNode({ id: 'b.md', title: 'Beta Smith', content: '', frontmatter: {} });

      // Should pick first substring match without throwing
      writer.addLink('Source.md', 'Smith', 'Linked to Smith.');

      const edges = store.getEdgesFrom('Source.md');
      expect(edges.length).toBeGreaterThan(0);
    });

    it('throws if source node file does not exist', () => {
      expect(() => writer.addLink('nonexistent.md', 'target', 'context')).toThrow(/not found/);
    });

    // ── Codex review #11: wiki-link injection via unescaped target/context ──

    it('rejects target containing `]]` (would break out of wiki-link)', () => {
      writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      expect(() =>
        writer.addLink('Source.md', 'foo]] [[malicious', 'context'),
      ).toThrow(/Unsafe link target/);
    });

    it('rejects target containing `[[` (would nest wiki-links)', () => {
      writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      expect(() =>
        writer.addLink('Source.md', 'foo [[bar', 'context'),
      ).toThrow(/Unsafe link target/);
    });

    it('rejects target containing newline (would split lines)', () => {
      writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      expect(() =>
        writer.addLink('Source.md', 'foo\nbar', 'context'),
      ).toThrow(/Unsafe link target/);
    });

    it('rejects target containing `|` (wiki-link alias delimiter)', () => {
      writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      expect(() =>
        writer.addLink('Source.md', 'foo|alias', 'context'),
      ).toThrow(/Unsafe link target/);
    });

    it('rejects empty target', () => {
      writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      expect(() =>
        writer.addLink('Source.md', '', 'context'),
      ).toThrow(/Unsafe link target/);
    });

    it('rejects context containing newline (would inject extra content)', () => {
      writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      expect(() =>
        writer.addLink('Source.md', 'Target', 'line1\n\n## Injected heading'),
      ).toThrow(/Unsafe link context/);
    });

    // ── Codex review #5 (2026-05-03): context cannot smuggle in extra wiki-links ──

    it('rejects context containing `[[` (would create phantom edge on reparse)', () => {
      writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      expect(() =>
        writer.addLink('Source.md', 'Target', 'see also [[Other Node]] for more'),
      ).toThrow(/Unsafe link context/);
    });

    it('rejects context containing `]]` alone (closing bracket leak)', () => {
      writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      expect(() =>
        writer.addLink('Source.md', 'Target', 'cf. earlier note]]'),
      ).toThrow(/Unsafe link context/);
    });

    it('rejects context containing `|` (wiki-alias delimiter leak)', () => {
      writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      expect(() =>
        writer.addLink('Source.md', 'Target', 'tagged | important'),
      ).toThrow(/Unsafe link context/);
    });

    it('error message points operator to annotateNode for arbitrary markdown', () => {
      writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      try {
        writer.addLink('Source.md', 'Target', 'has [[bad]] context');
        expect.fail('expected throw');
      } catch (err) {
        expect((err as Error).message).toMatch(/annotateNode/);
      }
    });

    it('accepts target with forward slashes (folder-nested refs are valid)', () => {
      writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      // Slashes allowed — wiki refs like "People/Alice" are first-class.
      expect(() =>
        writer.addLink('Source.md', 'People/Alice Smith', 'A note.'),
      ).not.toThrow();
    });

    it('accepts context with markdown punctuation but no newlines', () => {
      writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      // Plain markdown text (asterisks, parens, hyphens) must still pass.
      expect(() =>
        writer.addLink('Source.md', 'Target', '*emphasized* (with parens) — and dashes.'),
      ).not.toThrow();
    });

    // ── Codex review #10: indexFile applies sanitizeFrontmatter ──

    it('strips prototype-pollution keys when re-indexing via writer paths', () => {
      // Create a file directly with a hostile frontmatter, bypassing
      // createNode's own input validation. annotateNode → indexFile is the
      // path that previously skipped sanitization.
      const evilPath = join(tempVault, 'Evil.md');
      const { writeFileSync: wfs } = require('fs') as typeof import('fs');
      wfs(
        evilPath,
        '---\n__proto__:\n  polluted: true\nconstructor:\n  evil: 1\nprototype:\n  x: y\nlegit: keep_me\n---\n# evil\n',
        'utf-8',
      );

      // Index via writer's annotate path (calls private indexFile).
      writer.annotateNode('Evil.md', '\nappended.\n');

      const node = store.getNode('Evil.md');
      expect(node).toBeDefined();
      const fm = node!.frontmatter as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(fm, '__proto__')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(fm, 'constructor')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(fm, 'prototype')).toBe(false);
      expect(fm.legit).toBe('keep_me');
    });
  });
});
