import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync, symlinkSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { cpSync } from 'fs';
import { VaultWriter } from '../src/lib/writer.js';
import { Store } from '../src/lib/store.js';
import { Embedder } from '../src/lib/embedder.js';
import { Search } from '../src/lib/search.js';

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
    it('creates a new markdown file with frontmatter', async () => {
      await writer.createNode({
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

    it('indexes the new node in the store', async () => {
      await writer.createNode({
        title: 'New Concept',
        directory: 'Concepts',
        frontmatter: { type: 'concept' },
        content: 'A test concept.',
      });

      const node = store.getNode('Concepts/New Concept.md');
      expect(node).toBeDefined();
      expect(node!.title).toBe('New Concept');
    });

    it('creates directories that do not exist', async () => {
      await writer.createNode({
        title: 'Fresh Note',
        directory: 'NewDir',
        frontmatter: {},
        content: 'In a new directory.',
      });

      const filePath = join(tempVault, 'NewDir', 'Fresh Note.md');
      expect(existsSync(filePath)).toBe(true);
    });

    it('creates at vault root when no directory specified', async () => {
      await writer.createNode({
        title: 'Root Note',
        frontmatter: {},
        content: 'At the root.',
      });

      const filePath = join(tempVault, 'Root Note.md');
      expect(existsSync(filePath)).toBe(true);
    });

    it('throws if the file already exists', async () => {
      await expect(writer.createNode({
        title: 'Alice Smith',
        directory: 'People',
        frontmatter: {},
        content: 'Duplicate.',
      })).rejects.toThrow(/already exists/);
    });

    // Regression: title comes from LLM/CLI input. Previously a title of
    // `../../etc/passwd` or `Foo/Bar` silently wrote outside the vault or
    // into an unintended subdirectory.
    it('rejects a title with a forward slash', async () => {
      await expect(writer.createNode({
        title: 'foo/bar',
        frontmatter: {},
        content: 'x',
      })).rejects.toThrow(/Unsafe title/);
    });

    it('rejects a title with a backslash', async () => {
      await expect(writer.createNode({
        title: 'foo\\bar',
        frontmatter: {},
        content: 'x',
      })).rejects.toThrow(/Unsafe title/);
    });

    it('rejects a title equal to ".." (parent directory)', async () => {
      await expect(writer.createNode({
        title: '..',
        frontmatter: {},
        content: 'x',
      })).rejects.toThrow(/Unsafe title/);
    });

    it('rejects a title with control characters', async () => {
      await expect(writer.createNode({
        title: 'foo\x00bar',
        frontmatter: {},
        content: 'x',
      })).rejects.toThrow(/Unsafe title/);
    });

    it('rejects an empty title', async () => {
      await expect(writer.createNode({
        title: '',
        frontmatter: {},
        content: 'x',
      })).rejects.toThrow(/Unsafe title/);
    });

    it('rejects a directory containing "../"', async () => {
      await expect(writer.createNode({
        title: 'Ok',
        directory: '../escape',
        frontmatter: {},
        content: 'x',
      })).rejects.toThrow(/Unsafe directory/);
    });

    it('rejects an absolute directory', async () => {
      await expect(writer.createNode({
        title: 'Ok',
        directory: '/etc',
        frontmatter: {},
        content: 'x',
      })).rejects.toThrow(/Unsafe directory/);
    });

    it('still accepts a nested directory path without parent refs', async () => {
      await writer.createNode({
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
    it('publishes via tmp+rename so no partial file is left under the final name', async () => {
      const dir = join(tempVault, 'Concepts');
      const before = readdirSync(dir);

      await writer.createNode({
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

    // Regression (finding writer.ts:160 / B-1): createNode used to write+rename
    // the file BEFORE any realpath vault-boundary check (assertPathInVault only
    // ran inside indexFile, after the file was already on disk). A symlinked
    // in-vault directory therefore materialized attacker/LLM-controlled content
    // OUTSIDE the vault before the guard fired. The check must run before write.
    it('rejects createNode through an in-vault symlinked directory before writing any file', async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'kg-outside-'));
      try {
        symlinkSync(outsideDir, join(tempVault, 'escape'));
        await expect(writer.createNode({
          title: 'Evil',
          directory: 'escape',
          frontmatter: {},
          content: 'attacker-controlled body',
        })).rejects.toThrow(/escapes vault/);
        // The out-of-vault file must NOT have been materialized.
        expect(existsSync(join(outsideDir, 'Evil.md'))).toBe(false);
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    // Regression (finding writer.ts:62): createNode accepted directories/titles
    // that parseVault deliberately skips — EXCLUDED_DIRS (e.g. `attachments`),
    // dot-prefixed directory segments, and dot-prefixed titles. The node was
    // written + indexed and looked stored, but the very next kg_index treated the
    // (parser-invisible) live node as a deleted file and silently deleteNode()'d
    // it. createNode must reject such parser-invisible paths up front.
    it('rejects an excluded directory (attachments) the indexer would skip', async () => {
      await expect(writer.createNode({
        title: 'Meeting Notes',
        directory: 'attachments',
        frontmatter: {},
        content: 'x',
      })).rejects.toThrow(/Unsafe directory/);
      expect(existsSync(join(tempVault, 'attachments', 'Meeting Notes.md'))).toBe(false);
    });

    it('rejects a dot-prefixed directory segment the indexer would skip', async () => {
      await expect(writer.createNode({
        title: 'Secret Plan',
        directory: '.agent-notes',
        frontmatter: {},
        content: 'x',
      })).rejects.toThrow(/Unsafe directory/);
    });

    it('rejects an excluded segment nested deeper in the directory path', async () => {
      await expect(writer.createNode({
        title: 'Note',
        directory: 'Projects/attachments',
        frontmatter: {},
        content: 'x',
      })).rejects.toThrow(/Unsafe directory/);
    });

    it('rejects a dot-prefixed title the indexer would skip', async () => {
      await expect(writer.createNode({
        title: '.hidden-title',
        frontmatter: {},
        content: 'x',
      })).rejects.toThrow(/Unsafe title/);
    });

    // Regression (finding writer.ts:138): mkdirSync ran BEFORE the vault-boundary
    // check, so a directory like `linked/deep/nested` where `linked` is an
    // in-vault symlink to an external dir made mkdirSync(recursive) follow the
    // symlink and create attacker/LLM-chosen directory trees OUTSIDE the vault
    // before assertPathInVault fired. The boundary check must run before mkdir.
    it('rejects createNode through a symlinked ancestor WITHOUT creating any external dir tree', async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'kg-outside-mkdir-'));
      try {
        symlinkSync(outsideDir, join(tempVault, 'linked'));
        await expect(writer.createNode({
          title: 'Evil',
          directory: 'linked/deep/nested',
          frontmatter: {},
          content: 'attacker-controlled body',
        })).rejects.toThrow(/escapes vault/);
        // No external directory tree may have been materialized.
        expect(existsSync(join(outsideDir, 'deep'))).toBe(false);
        expect(existsSync(join(outsideDir, 'deep', 'nested'))).toBe(false);
        expect(existsSync(join(outsideDir, 'deep', 'nested', 'Evil.md'))).toBe(false);
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

  });

  describe('annotateNode', () => {
    it('appends content to an existing file', async () => {
      await writer.annotateNode('People/Alice Smith.md', '\n## Agent Notes\nAlice is a key connector.');

      const raw = readFileSync(join(tempVault, 'People', 'Alice Smith.md'), 'utf-8');
      expect(raw).toContain('## Agent Notes');
      expect(raw).toContain('Alice is a key connector.');
    });

    it('re-indexes the node in the store after annotation', async () => {
      // First index the original
      await writer.createNode({
        title: 'Temp Note',
        frontmatter: {},
        content: 'Original content.',
      });
      const before = store.getNode('Temp Note.md');
      expect(before!.content).toContain('Original content.');

      await writer.annotateNode('Temp Note.md', '\n\nAppended content.');
      const after = store.getNode('Temp Note.md');
      expect(after!.content).toContain('Appended content.');
    });

    it('throws if the node does not exist', async () => {
      await expect(writer.annotateNode('nonexistent.md', 'stuff')).rejects.toThrow(/not found/);
    });

    // Regression (MAJOR-2): a vault file containing [[../../etc/secrets]] generates
    // stub ID `_stub/../../etc/secrets.md`. Without the confinement guard,
    // annotateNode resolves the `..` segments and appends outside the vault root.
    it('rejects a node ID that escapes the vault via path traversal', async () => {
      // The path does not need to exist — the guard fires before existsSync.
      await expect(
        writer.annotateNode('../../escape.md', 'x'),
      ).rejects.toThrow(/escapes vault/);
    });

    it('rejects a stub node ID that resolves outside the vault via ..', async () => {
      await expect(
        writer.annotateNode('_stub/../../outside.md', 'x'),
      ).rejects.toThrow(/escapes vault/);
    });

    // MINOR-C: when BOTH the target file and its parent directory are missing
    // (e.g. a traversal id whose containing dir does not exist), the guard must
    // still throw the clean "escapes vault" error — not propagate a raw
    // ENOENT from the realpathSync fallback. The existing traversal tests only
    // cover ids whose parent dir happens to exist, so this path was uncovered.
    it('throws "escapes vault" (not ENOENT) when the escaping parent dir is also missing', async () => {
      await expect(
        writer.annotateNode('../../nope-does-not-exist/deep/x.md', 'y'),
      ).rejects.toThrow(/escapes vault/);
      // And explicitly assert it is NOT the raw OS error.
      await expect(
        writer.annotateNode('../../nope-does-not-exist/deep/x.md', 'y'),
      ).rejects.not.toThrow(/ENOENT/);
    });

    // Regression (symlink escape): a symlink planted INSIDE the vault pointing
    // to a path outside the vault bypasses the old lexical path.resolve() guard
    // because resolve() returns the symlink's own path (still lexically inside
    // the vault).  The realpath-based guard follows the symlink and sees the
    // real target is outside the vault.
    //
    // NOTE: this test FAILS against the old lexical-only code (resolve() keeps
    // the path appearing inside the vault) and PASSES after the realpathSync fix.
    it('rejects a node ID that resolves through an in-vault symlink to outside the vault', async () => {
      // Plant a symlink at vault/escape → /tmp (guaranteed to exist on POSIX).
      const symlinkInVault = join(tempVault, 'escape');
      symlinkSync('/tmp', symlinkInVault);

      // nodeId 'escape' → absPath = vault/escape → realpathSync follows the
      // symlink → /private/tmp (or /tmp) which is outside the vault.
      await expect(
        writer.annotateNode('escape', 'x'),
      ).rejects.toThrow(/escapes vault/);
    });
  });

  describe('addLink', () => {
    it('appends a wiki link to the source file', async () => {
      await writer.createNode({
        title: 'Source',
        frontmatter: {},
        content: 'Some content.',
      });

      await writer.addLink('Source.md', 'People/Alice Smith', 'Related to Alice.');

      const raw = readFileSync(join(tempVault, 'Source.md'), 'utf-8');
      expect(raw).toContain('[[People/Alice Smith]]');
      expect(raw).toContain('Related to Alice.');
    });

    it('creates an edge in the store', async () => {
      await writer.createNode({
        title: 'Source',
        frontmatter: {},
        content: 'Some content.',
      });

      await writer.addLink('Source.md', 'People/Alice Smith', 'Related to Alice.');

      // Unknown targets now route through the parser-compatible `_stub/`
      // prefix so IndexPipeline.reconciliation can later rewrite the edge
      // when the real file appears. Previous behavior wrote bare
      // "People/Alice Smith.md" — graph-invisible until next reparse.
      const edges = store.getEdgesFrom('Source.md');
      expect(edges.some(e => e.targetId === '_stub/People/Alice Smith.md')).toBe(true);
    });

    it('resolves target by title to full node ID', async () => {
      await writer.createNode({
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
      await writer.addLink('Source.md', 'Widget Theory', 'Uses widget theory.');

      const edges = store.getEdgesFrom('Source.md');
      expect(edges.some(e => e.targetId === 'Concepts/Widget Theory.md')).toBe(true);
    });

    it('uses _stub/ prefix for unknown targets (matches parser semantics)', async () => {
      await writer.createNode({
        title: 'Source',
        frontmatter: {},
        content: 'Some content.',
      });

      await writer.addLink('Source.md', 'Unknown Target', 'Linked to unknown.');

      const edges = store.getEdgesFrom('Source.md');
      expect(edges.some(e => e.targetId === '_stub/Unknown Target.md')).toBe(true);

      // Stub node is materialized so KnowledgeGraph.fromStore includes the
      // edge in adjacency builds (without this, the link is invisible to
      // graph traversal until the next full reparse).
      expect(store.getNode('_stub/Unknown Target.md')).toBeDefined();
    });

    it('appends .md to stub IDs even when the target already ends in .md (parser parity)', async () => {
      await writer.createNode({
        title: 'Source',
        frontmatter: {},
        content: 'Some content.',
      });

      await writer.addLink('Source.md', 'Unknown.md', 'Link context.');

      // parser.ts emits `_stub/${link.raw}.md` UNCONDITIONALLY, so the
      // literal `[[Unknown.md]]` this call appended re-parses to
      // `_stub/Unknown.md.md`. The writer must mint the SAME ID: its old
      // `_stub/Unknown.md` diverged, so the next IndexPipeline run
      // misclassified it as a resolved stub, deleted it, and re-created the
      // parser-shaped stub — phantom stub churn on every full index.
      const edges = store.getEdgesFrom('Source.md');
      expect(edges.some(e => e.targetId === '_stub/Unknown.md.md')).toBe(true);
      expect(store.getNode('_stub/Unknown.md.md')).toBeDefined();
    });

    it('does NOT use _stub/ prefix when target resolves to an existing node', async () => {
      await writer.createNode({
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

      await writer.addLink('Source.md', 'Bob', 'Hi Bob.');

      const edges = store.getEdgesFrom('Source.md');
      // Resolved targets bypass the stub prefix entirely.
      expect(edges.some(e => e.targetId === 'People/Bob.md')).toBe(true);
      expect(edges.some(e => e.targetId.startsWith('_stub/'))).toBe(false);
    });

    // Perf regression guard (finding writer.ts:232): an exact-ID match always
    // re-resolves to the same node via resolveLink's direct-path lookup, so the
    // reparse-consistency guard's O(N) allNodeIds() full-table scan is vacuous
    // for id matches and must be short-circuited. Booby-trap allNodeIds() to
    // throw: if the id short-circuit is removed, the guard runs the scan and
    // this call blows up. (Behavior is unchanged — the edge still resolves.)
    it('does not run the O(N) allNodeIds() scan when the target is an exact-ID match', async () => {
      await writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      store.upsertNode({ id: 'People/Bob.md', title: 'Bob', content: '', frontmatter: {} });

      (store as unknown as { allNodeIds: () => string[] }).allNodeIds = () => {
        throw new Error('allNodeIds must not be called for an id-matched addLink');
      };

      // Link by full ID (priority-0 match) — must succeed without scanning.
      await writer.addLink('Source.md', 'People/Bob.md', 'Hi Bob.');

      const edges = store.getEdgesFrom('Source.md');
      expect(edges.some(e => e.targetId === 'People/Bob.md')).toBe(true);
      expect(edges.some(e => e.targetId.startsWith('_stub/'))).toBe(false);
    });

    it('picks first match when target resolves ambiguously', async () => {
      await writer.createNode({
        title: 'Source',
        frontmatter: {},
        content: 'Some content.',
      });
      store.upsertNode({ id: 'a.md', title: 'Alpha Smith', content: '', frontmatter: {} });
      store.upsertNode({ id: 'b.md', title: 'Beta Smith', content: '', frontmatter: {} });

      // Should pick first substring match without throwing
      await writer.addLink('Source.md', 'Smith', 'Linked to Smith.');

      const edges = store.getEdgesFrom('Source.md');
      expect(edges.length).toBeGreaterThan(0);
    });

    it('throws if source node file does not exist', async () => {
      await expect(writer.addLink('nonexistent.md', 'target', 'context')).rejects.toThrow(/not found/);
    });

    // Regression (finding writer.ts:230 / A-5): addLink's stub check only
    // inspected matches[0], so when a stub node and a REAL note share a title,
    // DB row order decided the target. The stub is minted first (earlier rowid)
    // in the normal timeline, so it sorted ahead of a later real note whose
    // filename stem differs from its title — silently attaching the edge to the
    // stub. addLink must prefer the first NON-stub match.
    it('prefers a real node over a same-title stub minted earlier (row-order independence)', async () => {
      await writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      // Stub minted FIRST; real note (stem `wt` ≠ title `Widget Theory`) later.
      store.upsertNode({ id: '_stub/Widget Theory.md', title: 'Widget Theory', content: '', frontmatter: { _stub: true } });
      store.upsertNode({ id: 'Concepts/wt.md', title: 'Widget Theory', content: 'the real note', frontmatter: {} });

      await writer.addLink('Source.md', 'Widget Theory', 'uses widget theory');

      const edges = store.getEdgesFrom('Source.md');
      expect(edges.some(e => e.targetId === 'Concepts/wt.md')).toBe(true);
      expect(edges.some(e => e.targetId.startsWith('_stub/'))).toBe(false);
      // And the written link is path-qualified so a full reparse re-resolves it
      // to the same real node.
      const raw = readFileSync(join(tempVault, 'Source.md'), 'utf-8');
      expect(raw).toContain('[[Concepts/wt]]');
    });

    // Regression (MAJOR-2): a source ID like `../../escape.md` must be rejected
    // before existsSync, preventing reads/writes outside the vault.
    it('rejects a source ID that escapes the vault via path traversal', async () => {
      await expect(
        writer.addLink('../../escape.md', 'Target', 'context'),
      ).rejects.toThrow(/escapes vault/);
    });

    // MINOR-2: calling addLink twice with the same unresolvable target must
    // materialize exactly one stub node (idempotent — not two stubs).
    it('does not duplicate stub node when addLink is called twice for the same unknown target', async () => {
      await writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      await writer.addLink('Source.md', 'Unknown', 'first context');
      await writer.addLink('Source.md', 'Unknown', 'second context');

      const stub = store.getNode('_stub/Unknown.md');
      expect(stub).toBeDefined();
      // Exactly one stub node with that ID.
      expect(store.allNodeIds().filter(id => id === '_stub/Unknown.md')).toHaveLength(1);
    });

    // Regression (finding writer.ts:218): the SECOND addLink to the same
    // still-unresolvable target must write the SAME readable `[[Target]]` link
    // the first call wrote — never the internal `[[_stub/Target]]` form. On
    // the second call resolveNodeName exact-title-matches the stub node minted
    // by the first call, so pre-fix code took the resolved branch, saw the
    // reparse-guard's resolveLink return null (stubs are not real files) and
    // rewrote the link to `[[_stub/Target]]`. That literal re-parses on the
    // next full index to a DIFFERENT double-nested stub (_stub/_stub/Target.md),
    // silently fragmenting the two links. The fix routes a stub-node match
    // through the unresolved branch so both calls emit identical output.
    it('writes a readable [[Target]] (never [[_stub/...]]) on the second addLink to the same unknown target', async () => {
      await writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      await writer.addLink('Source.md', 'Unknown', 'first context');
      await writer.addLink('Source.md', 'Unknown', 'second context');

      const raw = readFileSync(join(tempVault, 'Source.md'), 'utf-8');
      // No line may contain the internal `_stub/` prefix — that prefix is an
      // implementation detail and must never leak into vault markdown.
      expect(raw).not.toContain('[[_stub/');
      // Both appended links are the readable form.
      expect(raw.match(/\[\[Unknown\]\]/g) ?? []).toHaveLength(2);

      // Both edges point at the one parser-shaped stub; no double-nested stub.
      const edges = store.getEdgesFrom('Source.md');
      expect(edges.every(e => e.targetId === '_stub/Unknown.md')).toBe(true);
      expect(store.allNodeIds().some(id => id.startsWith('_stub/_stub/'))).toBe(false);
    });

    // ── Codex review #11: wiki-link injection via unescaped target/context ──

    it('rejects target containing `]]` (would break out of wiki-link)', async () => {
      await writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      await expect(
        writer.addLink('Source.md', 'foo]] [[malicious', 'context'),
      ).rejects.toThrow(/Unsafe link target/);
    });

    it('rejects target containing `[[` (would nest wiki-links)', async () => {
      await writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      await expect(
        writer.addLink('Source.md', 'foo [[bar', 'context'),
      ).rejects.toThrow(/Unsafe link target/);
    });

    it('rejects target containing newline (would split lines)', async () => {
      await writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      await expect(
        writer.addLink('Source.md', 'foo\nbar', 'context'),
      ).rejects.toThrow(/Unsafe link target/);
    });

    it('rejects target containing `|` (wiki-link alias delimiter)', async () => {
      await writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      await expect(
        writer.addLink('Source.md', 'foo|alias', 'context'),
      ).rejects.toThrow(/Unsafe link target/);
    });

    it('rejects empty target', async () => {
      await writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      await expect(
        writer.addLink('Source.md', '', 'context'),
      ).rejects.toThrow(/Unsafe link target/);
    });

    it('rejects context containing newline (would inject extra content)', async () => {
      await writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      await expect(
        writer.addLink('Source.md', 'Target', 'line1\n\n## Injected heading'),
      ).rejects.toThrow(/Unsafe link context/);
    });

    // ── Codex review #5 (2026-05-03): context cannot smuggle in extra wiki-links ──

    it('rejects context containing `[[` (would create phantom edge on reparse)', async () => {
      await writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      await expect(
        writer.addLink('Source.md', 'Target', 'see also [[Other Node]] for more'),
      ).rejects.toThrow(/Unsafe link context/);
    });

    it('rejects context containing `]]` alone (closing bracket leak)', async () => {
      await writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      await expect(
        writer.addLink('Source.md', 'Target', 'cf. earlier note]]'),
      ).rejects.toThrow(/Unsafe link context/);
    });

    it('rejects context containing `|` (wiki-alias delimiter leak)', async () => {
      await writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      await expect(
        writer.addLink('Source.md', 'Target', 'tagged | important'),
      ).rejects.toThrow(/Unsafe link context/);
    });

    it('error message points operator to annotateNode for arbitrary markdown', async () => {
      await writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      await expect(
        writer.addLink('Source.md', 'Target', 'has [[bad]] context'),
      ).rejects.toThrow(/annotateNode/);
    });

    it('accepts target with forward slashes (folder-nested refs are valid)', async () => {
      await writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      // Slashes allowed — wiki refs like "People/Alice" are first-class.
      await expect(
        writer.addLink('Source.md', 'People/Alice Smith', 'A note.'),
      ).resolves.not.toThrow();
    });

    it('accepts context with markdown punctuation but no newlines', async () => {
      await writer.createNode({ title: 'Source', frontmatter: {}, content: 'x' });
      // Plain markdown text (asterisks, parens, hyphens) must still pass.
      await expect(
        writer.addLink('Source.md', 'Target', '*emphasized* (with parens) — and dashes.'),
      ).resolves.not.toThrow();
    });

    // ── Codex review #10: indexFile applies sanitizeFrontmatter ──

    it('strips prototype-pollution keys when re-indexing via writer paths', async () => {
      // Create a file directly with a hostile frontmatter, bypassing
      // createNode's own input validation. annotateNode → indexFile is the
      // path that previously skipped sanitization.
      const evilPath = join(tempVault, 'Evil.md');
      writeFileSync(
        evilPath,
        '---\n__proto__:\n  polluted: true\nconstructor:\n  evil: 1\nprototype:\n  x: y\nlegit: keep_me\n---\n# evil\n',
        'utf-8',
      );

      // Index via writer's annotate path (calls private indexFile).
      await writer.annotateNode('Evil.md', '\nappended.\n');

      const node = store.getNode('Evil.md');
      expect(node).toBeDefined();
      const fm = node!.frontmatter as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(fm, '__proto__')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(fm, 'constructor')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(fm, 'prototype')).toBe(false);
      expect(fm.legit).toBe('keep_me');
    });

    // Same failure class as the parser-side title guard: a non-string
    // `title:` (array/number) previously flowed into Store.upsertNode where
    // better-sqlite3 cannot bind it — annotateNode/addLink on such a file
    // threw and the whole writer call died. Must fall back to the filename.
    it('falls back to filename when frontmatter title is not a string', async () => {
      const arrPath = join(tempVault, 'ArrayTitle.md');
      writeFileSync(arrPath, '---\ntitle:\n  - part1\n  - part2\n---\nBody.\n', 'utf-8');

      await writer.annotateNode('ArrayTitle.md', '\nappended.\n');

      const node = store.getNode('ArrayTitle.md');
      expect(node).toBeDefined();
      expect(node!.title).toBe('ArrayTitle');
    });
  });

  // ── Finding 3: nodes created/annotated via the writer must be embedded so
  // they are immediately returnable by semantic search (the MCP default),
  // not invisible until a full re-index. Uses the real embedder (matches
  // search.test.ts / index-pipeline.test.ts), so embeddings round-trip
  // through nodes_vec exactly as kg_search would query them.
  describe('embedding on write (semantic searchability)', () => {
    let embedder: Embedder;

    beforeAll(async () => {
      embedder = new Embedder();
      await embedder.init();
    }, 60000);

    afterAll(async () => {
      await embedder.dispose();
    });

    it('createNode embeds the node so semantic search returns it without a re-index', async () => {
      const w = new VaultWriter(tempVault, store, embedder);
      await w.createNode({
        title: 'Quantum Entanglement',
        directory: 'Concepts',
        frontmatter: { type: 'concept' },
        content: 'Two particles remain correlated across any distance.',
      });

      const search = new Search(store, embedder);
      const results = await search.semantic('quantum entanglement correlated particles');
      expect(results.some(r => r.nodeId === 'Concepts/Quantum Entanglement.md')).toBe(true);
    });

    // The embedding contract is title + tags + FIRST paragraph only
    // (Embedder.buildEmbeddingText) — content appended BEHIND an existing
    // first paragraph does NOT change the vector. The previous form of this
    // test ("appended content is searchable") was vacuous: with a 2-3 node
    // embedded corpus and k=20 KNN, every embedded node is always returned,
    // so it passed even if annotateNode skipped re-embedding entirely.
    // Instead: start from an EMPTY body (so the annotation becomes the first
    // paragraph) and assert the STORED vector actually changed.
    it('annotateNode recomputes the stored embedding from the updated file', async () => {
      const w = new VaultWriter(tempVault, store, embedder);
      await w.createNode({
        title: 'Sparse Note',
        frontmatter: {},
        content: '',
      });

      const rowid = store.getNode('Sparse Note.md')!.rowid;
      const readVec = () => store.db.prepare(
        'SELECT embedding FROM nodes_vec WHERE rowid = ?'
      ).get(BigInt(rowid)) as { embedding: Buffer };

      const before = Buffer.from(readVec().embedding);
      await w.annotateNode(
        'Sparse Note.md',
        'Photosynthesis converts sunlight into chemical energy in chloroplasts.',
      );
      const after = Buffer.from(readVec().embedding);

      expect(after.equals(before)).toBe(false);
    });

    it('without an embedder, createNode still writes the node but skips embedding (back-compat)', async () => {
      // No embedder injected — node is FTS/graph indexed but has no vector row.
      const plain = new VaultWriter(tempVault, store);
      await plain.createNode({
        title: 'No Vector Note',
        frontmatter: {},
        content: 'This node has no embedding.',
      });
      expect(store.getNode('No Vector Note.md')).toBeDefined();
      // It is full-text searchable...
      const fts = store.searchFullText('embedding');
      expect(fts.some(r => r.nodeId === 'No Vector Note.md')).toBe(true);
    });
  });
});
