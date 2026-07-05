import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../src/lib/store.js';
import { resolveNodeName, requireMatch } from '../src/lib/resolve.js';

describe('requireMatch (MCP disambiguation)', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
    store.upsertNode({
      id: 'People/Alice Smith.md', title: 'Alice Smith',
      content: '', frontmatter: { aliases: ['A. Smith'] },
    });
    store.upsertNode({
      id: 'Concepts/Widget Theory.md', title: 'Widget Theory',
      content: '', frontmatter: {},
    });
    store.upsertNode({
      id: 'smith2.md', title: 'John Smith',
      content: '', frontmatter: {},
    });
  });

  afterEach(() => store.close());

  it('resolves exact title match', () => {
    expect(requireMatch('Alice Smith', store)).toBe('People/Alice Smith.md');
  });

  it('resolves alias match', () => {
    expect(requireMatch('A. Smith', store)).toBe('People/Alice Smith.md');
  });

  it('resolves by node ID', () => {
    expect(requireMatch('Concepts/Widget Theory.md', store)).toBe('Concepts/Widget Theory.md');
  });

  it('throws on no match', () => {
    expect(() => requireMatch('Nonexistent', store)).toThrow('No node found');
  });

  it('throws on ambiguous substring match', () => {
    // "Smith" matches both "Alice Smith" and "John Smith" via substring
    expect(() => requireMatch('Smith', store)).toThrow('Ambiguous');
  });

  // Behavior change (finding resolve.ts:11): `title` has NO UNIQUE constraint,
  // so two notes in different directories can share an exact title. The old
  // code treated exact/case-insensitive multi-hits as high-confidence and
  // silently returned matches[0] (arbitrary DB order) — every downstream
  // read/write then operated on the WRONG node with no error. These tests
  // pin the fail-loud contract: multi-match on anything but a pure `id` hit
  // must throw AND list all candidates so the caller can disambiguate. A
  // mutation that reverts to pick-first, or throws without naming candidates,
  // fails here (the old tests survived the bug by asserting pick-first).
  it('throws on multi-result exact-title match, listing both candidates', () => {
    store.upsertNode({
      id: 'dup.md', title: 'Alice Smith',
      content: '', frontmatter: {},
    });
    expect(() => requireMatch('Alice Smith', store)).toThrow('Ambiguous');
    try {
      requireMatch('Alice Smith', store);
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e.message).toContain('People/Alice Smith.md');
      expect(e.message).toContain('dup.md');
    }
  });

  it('throws on case-insensitive multi-match, listing both candidates', () => {
    // Query "Index" equals NEITHER title by case (so the exact-case Priority-1
    // pass misses) but matches both case-insensitively → genuine ambiguity.
    store.upsertNode({ id: 'Projects/INDEX.md', title: 'INDEX', content: '', frontmatter: {} });
    store.upsertNode({ id: 'Areas/index.md', title: 'index', content: '', frontmatter: {} });
    expect(() => requireMatch('Index', store)).toThrow('Ambiguous');
    try {
      requireMatch('Index', store);
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e.message).toContain('Projects/INDEX.md');
      expect(e.message).toContain('Areas/index.md');
    }
  });

  it('still resolves a UNIQUE exact/case-insensitive title without throwing', () => {
    // Guard the guard: single hits must NOT regress into false ambiguity.
    expect(requireMatch('Alice Smith', store)).toBe('People/Alice Smith.md');
    expect(requireMatch('alice smith', store)).toBe('People/Alice Smith.md');
  });

  it('throws on ambiguous alias match', () => {
    store.upsertNode({
      id: 'other.md', title: 'Other',
      content: '', frontmatter: { aliases: ['A. Smith'] },
    });
    // "A. Smith" matches both Alice Smith and Other via alias
    expect(() => requireMatch('A. Smith', store)).toThrow('Ambiguous');
  });

  // Finding #35: empty/whitespace-only name flows through all resolution passes
  // because JS `'anything'.includes('') === true`, so priority-4 substring match
  // returns EVERY node. requireMatch then throws "Ambiguous name \"\"" and lists
  // every node — confusing the LLM into thinking 300 nodes are all titled ''.
  // A single-node vault is worse: requireMatch silently returns the one node
  // (wrong result, no error).
  // Intent: fail loud with a clear "cannot be empty" error before any DB access.
  it('requireMatch throws "cannot be empty" for an empty string, not "Ambiguous"', () => {
    expect(() => requireMatch('', store)).toThrow(/cannot be empty/i);
  });

  it('requireMatch throws "cannot be empty" for a whitespace-only string', () => {
    expect(() => requireMatch('   ', store)).toThrow(/cannot be empty/i);
  });
});

describe('resolveNodeName', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
    store.upsertNode({
      id: 'People/Alice Smith.md', title: 'Alice Smith',
      content: '', frontmatter: { aliases: ['A. Smith'] },
    });
    store.upsertNode({
      id: 'Concepts/Widget Theory.md', title: 'Widget Theory',
      content: '', frontmatter: { aliases: ['Widget Framework', 'WT'] },
    });
  });

  afterEach(() => store.close());

  it('matches exact title', () => {
    const matches = resolveNodeName('Alice Smith', store);
    expect(matches).toHaveLength(1);
    expect(matches[0].matchType).toBe('exact');
  });

  it('matches case-insensitively', () => {
    const matches = resolveNodeName('alice smith', store);
    expect(matches).toHaveLength(1);
    expect(matches[0].matchType).toBe('case-insensitive');
  });

  it('matches aliases', () => {
    const matches = resolveNodeName('WT', store);
    expect(matches).toHaveLength(1);
    expect(matches[0].matchType).toBe('alias');
    expect(matches[0].nodeId).toBe('Concepts/Widget Theory.md');
  });

  it('matches substrings', () => {
    const matches = resolveNodeName('Widget', store);
    expect(matches).toHaveLength(1);
    expect(matches[0].matchType).toBe('substring');
  });

  it('returns empty for no match', () => {
    const matches = resolveNodeName('Nonexistent', store);
    expect(matches).toHaveLength(0);
  });

  it('prefers exact over case-insensitive', () => {
    const matches = resolveNodeName('Alice Smith', store);
    expect(matches[0].matchType).toBe('exact');
  });

  it('matches by exact node ID (file path)', () => {
    const matches = resolveNodeName('People/Alice Smith.md', store);
    expect(matches).toHaveLength(1);
    expect(matches[0].matchType).toBe('id');
    expect(matches[0].nodeId).toBe('People/Alice Smith.md');
  });

  it('matches by node ID without .md extension', () => {
    const matches = resolveNodeName('Concepts/Widget Theory', store);
    expect(matches).toHaveLength(1);
    expect(matches[0].matchType).toBe('id');
    expect(matches[0].nodeId).toBe('Concepts/Widget Theory.md');
  });

  it('prefers ID match over title match', () => {
    const matches = resolveNodeName('People/Alice Smith.md', store);
    expect(matches[0].matchType).toBe('id');
  });

  it('matches any of multiple aliases', () => {
    const m1 = resolveNodeName('Widget Framework', store);
    expect(m1).toHaveLength(1);
    expect(m1[0].matchType).toBe('alias');
    expect(m1[0].nodeId).toBe('Concepts/Widget Theory.md');

    const m2 = resolveNodeName('A. Smith', store);
    expect(m2).toHaveLength(1);
    expect(m2[0].matchType).toBe('alias');
    expect(m2[0].nodeId).toBe('People/Alice Smith.md');
  });

  it('alias match is case-insensitive', () => {
    const matches = resolveNodeName('wt', store);
    expect(matches).toHaveLength(1);
    expect(matches[0].matchType).toBe('alias');
  });

  it('substring match returns multiple results', () => {
    store.upsertNode({
      id: 'smith2.md', title: 'John Smith',
      content: '', frontmatter: {},
    });
    const matches = resolveNodeName('Smith', store);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches.every(m => m.matchType === 'substring')).toBe(true);
  });

  // MAJOR-1: resolveNodeName must not degrade to O(N) on large vaults. An
  // id/exact-title lookup must be served by an indexed SQL query and must NOT
  // fall through to the getAllNodes() full scan that priorities 2–4 use. We
  // encode that intent structurally (not via wall-clock, which flakes under
  // coverage/load and stays green even if the index is removed on a fast box):
  // make getAllNodes() throw, so any code path that scans blows up. An
  // exact-title match must still resolve, proving the hot path never scans.
  it('resolves an exact-title match without touching the getAllNodes() scan', () => {
    const bigStore = new Store(':memory:');
    for (let i = 0; i < 2000; i++) {
      bigStore.upsertNode({
        id: `bulk${i}.md`,
        title: `Bulk Node ${i}`,
        content: '',
        frontmatter: { aliases: [`alias-${i}`] },
      });
    }
    // Booby-trap the full scan: if the exact-title path reaches priority 2–4,
    // this throws and fails the test.
    let scanCalls = 0;
    bigStore.getAllNodes = () => {
      scanCalls++;
      throw new Error('getAllNodes() scan must not run for an exact-title lookup');
    };
    const matches = resolveNodeName('Bulk Node 999', bigStore);
    expect(matches).toHaveLength(1);
    expect(matches[0].matchType).toBe('exact');
    expect(matches[0].nodeId).toBe('bulk999.md');
    expect(scanCalls).toBe(0);

    // Same for an exact-ID lookup (priority 0).
    const byId = resolveNodeName('bulk123.md', bigStore);
    expect(byId).toHaveLength(1);
    expect(byId[0].matchType).toBe('id');
    expect(scanCalls).toBe(0);
    bigStore.close();
  });

  // Regression: Obsidian permits a SCALAR `aliases:` (e.g. `aliases: MyAlias`),
  // which gray-matter parses to a bare string, not an array. The alias-match
  // loop did `(fm.aliases as string[]).some(...)` — a lie that threw
  // "aliases.some is not a function" the moment a query fell through to the
  // alias pass. Because resolveNodeName scans EVERY node, one malformed note
  // bricked name resolution vault-wide (and thus nearly every MCP tool).
  // Intent: a scalar alias must be treated as a one-element list, not crash.
  it('does not crash when a node has a scalar (non-array) aliases value', () => {
    store.upsertNode({
      id: 'scalar.md', title: 'Scalar Note',
      content: '', frontmatter: { aliases: 'Solo Alias' },
    });
    // Query falls through to the alias pass (no title/id match) — must not throw.
    expect(() => resolveNodeName('Nonexistent Query', store)).not.toThrow();
  });

  it('matches a scalar aliases value as a single alias', () => {
    store.upsertNode({
      id: 'scalar.md', title: 'Scalar Note',
      content: '', frontmatter: { aliases: 'Solo Alias' },
    });
    const matches = resolveNodeName('Solo Alias', store);
    expect(matches).toHaveLength(1);
    expect(matches[0].matchType).toBe('alias');
    expect(matches[0].nodeId).toBe('scalar.md');
  });

  it('ignores non-string elements inside an aliases array without crashing', () => {
    store.upsertNode({
      id: 'mixed.md', title: 'Mixed Note',
      // numbers/null are not valid alias strings but must not throw on .toLowerCase()
      content: '', frontmatter: { aliases: [42, null, 'Good Alias'] },
    });
    expect(() => resolveNodeName('Nonexistent Query', store)).not.toThrow();
    const matches = resolveNodeName('Good Alias', store);
    expect(matches).toHaveLength(1);
    expect(matches[0].matchType).toBe('alias');
  });

  // MAJOR: substring resolution must treat a literal `_` in the query as a
  // plain character, NOT a SQL LIKE single-char wildcard. Before the JS-filter
  // fix, `LOWER(title) LIKE '%a_b%'` matched 'aXb' (the '_' matched any char),
  // so kg_annotate_node('a_b') silently appended to the WRONG file.
  it('treats a literal underscore in the query as a plain char, not a wildcard', () => {
    const s = new Store(':memory:');
    s.upsertNode({ id: 'axb.md', title: 'aXb', content: '', frontmatter: {} });
    // No exact/ci/alias match; substring must NOT match 'aXb' via '_' wildcard.
    expect(resolveNodeName('a_b', s)).toHaveLength(0);
    // A genuine literal-underscore title still matches literally.
    s.upsertNode({ id: 'lit.md', title: 'foo_bar', content: '', frontmatter: {} });
    const m = resolveNodeName('o_b', s);
    expect(m).toHaveLength(1);
    expect(m[0].nodeId).toBe('lit.md');
    expect(m[0].matchType).toBe('substring');
    s.close();
  });

  // MAJOR: a literal `%` must not act as a SQL LIKE match-everything wildcard.
  // Before the fix, `LOWER(title) LIKE '%%%'` matched every node.
  it('does not treat a literal percent as a match-all wildcard', () => {
    const s = new Store(':memory:');
    s.upsertNode({ id: 'a.md', title: 'Alpha', content: '', frontmatter: {} });
    s.upsertNode({ id: 'b.md', title: 'Beta', content: '', frontmatter: {} });
    // '%' appears in no title, so it must match nothing (old LIKE matched all).
    expect(resolveNodeName('%', s)).toHaveLength(0);
    s.close();
  });

  // MINOR: case-insensitive match must be Unicode-correct. SQLite's default
  // (no-ICU) LOWER() only folds A–Z, so 'ÉCOLE' queried as 'école' returned
  // [] under the SQL path; JS toLowerCase() folds it correctly.
  it('matches non-ASCII (accented-Latin) titles case-insensitively', () => {
    const s = new Store(':memory:');
    s.upsertNode({ id: 'ecole.md', title: 'ÉCOLE', content: '', frontmatter: {} });
    const m = resolveNodeName('école', s);
    expect(m).toHaveLength(1);
    expect(m[0].nodeId).toBe('ecole.md');
    expect(m[0].matchType).toBe('case-insensitive');
    s.close();
  });

  // MINOR: Turkish-cased title, another non-ASCII case-fold that SQLite's
  // ASCII LOWER() mishandles.
  it('matches a Turkish-cased title case-insensitively (Ü fold)', () => {
    const s = new Store(':memory:');
    s.upsertNode({ id: 'm.md', title: 'MÜNCHEN', content: '', frontmatter: {} });
    const m = resolveNodeName('münchen', s);
    expect(m).toHaveLength(1);
    expect(m[0].nodeId).toBe('m.md');
    expect(m[0].matchType).toBe('case-insensitive');
    s.close();
  });

  // A CJK title (no case) round-trips through the JS-filter path unchanged.
  it('resolves a CJK title by exact and substring', () => {
    const s = new Store(':memory:');
    s.upsertNode({ id: 'zh.md', title: '知識圖譜', content: '', frontmatter: {} });
    expect(resolveNodeName('知識圖譜', s)[0].matchType).toBe('exact');
    const sub = resolveNodeName('圖譜', s);
    expect(sub).toHaveLength(1);
    expect(sub[0].matchType).toBe('substring');
    s.close();
  });

  // Finding #35 (resolveNodeName half): an empty name must return [] and must
  // NOT fall through to priority-4 substring, where JS `''.includes('')` is
  // unconditionally true and every node becomes a "match". Without the guard,
  // resolveNodeName('', store) returns all nodes as substring hits — the caller
  // (requireMatch) then throws "Ambiguous name \"\"" listing every node, or
  // silently returns the one node in a single-node store (wrong result).
  it('resolveNodeName returns [] for an empty string, not all nodes as substring hits', () => {
    const s = new Store(':memory:');
    s.upsertNode({ id: 'one.md', title: 'One', content: '', frontmatter: {} });
    s.upsertNode({ id: 'two.md', title: 'Two', content: '', frontmatter: {} });
    const matches = resolveNodeName('', s);
    expect(matches).toHaveLength(0);
    s.close();
  });

  it('resolveNodeName returns [] for a whitespace-only string', () => {
    const s = new Store(':memory:');
    // 'A   B' (three internal spaces) is required: without the guard,
    // priority-4 does `'a   b'.includes('   ')` which is true, so the
    // substring pass WOULD return this node as a match. With the guard
    // (`if (!name.trim()) return []`) it never reaches that check.
    // A title like 'One' (no spaces) is vacuous — '   ' is not a
    // substring of 'one', so the test passes even on reverted code.
    s.upsertNode({ id: 'a-b.md', title: 'A   B', content: '', frontmatter: {} });
    const matches = resolveNodeName('   ', s);
    expect(matches).toHaveLength(0);
    s.close();
  });
});
