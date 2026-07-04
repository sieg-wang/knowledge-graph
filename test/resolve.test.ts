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

  it('does not throw on multi-result exact match', () => {
    store.upsertNode({
      id: 'dup.md', title: 'Alice Smith',
      content: '', frontmatter: {},
    });
    expect(requireMatch('Alice Smith', store)).toBe('People/Alice Smith.md');
  });

  it('does not throw on case-insensitive multi-match', () => {
    store.upsertNode({
      id: 'lower.md', title: 'widget theory',
      content: '', frontmatter: {},
    });
    // "widget theory" matches both via case-insensitive — should pick first, not throw
    expect(() => requireMatch('widget theory', store)).not.toThrow();
  });

  it('throws on ambiguous alias match', () => {
    store.upsertNode({
      id: 'other.md', title: 'Other',
      content: '', frontmatter: { aliases: ['A. Smith'] },
    });
    // "A. Smith" matches both Alice Smith and Other via alias
    expect(() => requireMatch('A. Smith', store)).toThrow('Ambiguous');
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

  // MAJOR-1: resolveNodeName must not degrade to O(N) on large vaults.
  // With 2000 nodes, an exact-title lookup should hit the idx_nodes_title
  // index and return in well under 50ms (was: O(N) full-table-scan + N JSON.parse).
  it('resolveNodeName with 2000 nodes returns an exact-title match in <50ms', () => {
    const bigStore = new Store(':memory:');
    for (let i = 0; i < 2000; i++) {
      bigStore.upsertNode({
        id: `bulk${i}.md`,
        title: `Bulk Node ${i}`,
        content: '',
        frontmatter: { aliases: [`alias-${i}`] },
      });
    }
    const start = Date.now();
    const matches = resolveNodeName('Bulk Node 999', bigStore);
    const elapsed = Date.now() - start;
    expect(matches).toHaveLength(1);
    expect(matches[0].matchType).toBe('exact');
    expect(elapsed).toBeLessThan(50);
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
});
