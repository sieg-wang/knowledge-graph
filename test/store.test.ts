import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../src/lib/store.js';

describe('Store', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('creates schema on initialization', () => {
    const tables = store.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all().map((r: any) => r.name);
    expect(tables).toContain('nodes');
    expect(tables).toContain('edges');
    expect(tables).toContain('communities');
    expect(tables).toContain('sync');
  });

  it('upserts and retrieves nodes', () => {
    store.upsertNode({
      id: 'test.md',
      title: 'Test',
      content: 'Hello world',
      frontmatter: { type: 'test' },
    });
    const node = store.getNode('test.md');
    expect(node).toBeDefined();
    expect(node!.title).toBe('Test');
    expect(node!.frontmatter).toEqual({ type: 'test' });
  });

  it('inserts and retrieves edges', () => {
    store.upsertNode({ id: 'a.md', title: 'A', content: '', frontmatter: {} });
    store.upsertNode({ id: 'b.md', title: 'B', content: '', frontmatter: {} });
    store.insertEdge({ sourceId: 'a.md', targetId: 'b.md', context: 'A links to B' });
    const edges = store.getEdgesFrom('a.md');
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe('b.md');
    expect(edges[0].context).toBe('A links to B');
  });

  it('allows multiple edges between the same pair', () => {
    store.upsertNode({ id: 'a.md', title: 'A', content: '', frontmatter: {} });
    store.upsertNode({ id: 'b.md', title: 'B', content: '', frontmatter: {} });
    store.insertEdge({ sourceId: 'a.md', targetId: 'b.md', context: 'First mention' });
    store.insertEdge({ sourceId: 'a.md', targetId: 'b.md', context: 'Second mention' });
    const edges = store.getEdgesFrom('a.md');
    expect(edges).toHaveLength(2);
  });

  it('retrieves backlinks (edges targeting a node)', () => {
    store.upsertNode({ id: 'a.md', title: 'A', content: '', frontmatter: {} });
    store.upsertNode({ id: 'b.md', title: 'B', content: '', frontmatter: {} });
    store.insertEdge({ sourceId: 'a.md', targetId: 'b.md', context: 'link' });
    const backlinks = store.getEdgesTo('b.md');
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0].sourceId).toBe('a.md');
  });

  it('performs full-text search via FTS5', () => {
    store.upsertNode({
      id: 'test.md',
      title: 'Widget Theory',
      content: 'A framework for understanding component interactions',
      frontmatter: {},
    });
    const results = store.searchFullText('framework component');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].nodeId).toBe('test.md');
  });

  it('tracks sync state', () => {
    store.upsertSync('test.md', 1000);
    expect(store.getSyncMtime('test.md')).toBe(1000);
    store.upsertSync('test.md', 2000);
    expect(store.getSyncMtime('test.md')).toBe(2000);
  });

  it('deletes a node and cascades to edges', () => {
    store.upsertNode({ id: 'a.md', title: 'A', content: '', frontmatter: {} });
    store.upsertNode({ id: 'b.md', title: 'B', content: '', frontmatter: {} });
    store.insertEdge({ sourceId: 'a.md', targetId: 'b.md', context: 'link' });
    store.deleteNode('a.md');
    expect(store.getNode('a.md')).toBeUndefined();
    expect(store.getEdgesFrom('a.md')).toHaveLength(0);
  });

  it('lists all node IDs', () => {
    store.upsertNode({ id: 'a.md', title: 'A', content: '', frontmatter: {} });
    store.upsertNode({ id: 'b.md', title: 'B', content: '', frontmatter: {} });
    expect(store.allNodeIds()).toEqual(expect.arrayContaining(['a.md', 'b.md']));
  });

  it('full-text search returns snippets', () => {
    store.upsertNode({
      id: 'test.md',
      title: 'Widget Theory',
      content: 'A framework for understanding component interactions in complex distributed systems',
      frontmatter: {},
    });
    const results = store.searchFullText('framework component');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].excerpt).not.toBe('');
    expect(results[0].excerpt).toContain('framework');
  });

  it('counts edges for a node', () => {
    store.upsertNode({ id: 'a.md', title: 'A', content: '', frontmatter: {} });
    store.upsertNode({ id: 'b.md', title: 'B', content: '', frontmatter: {} });
    store.upsertNode({ id: 'c.md', title: 'C', content: '', frontmatter: {} });
    store.insertEdge({ sourceId: 'a.md', targetId: 'b.md', context: 'link 1' });
    store.insertEdge({ sourceId: 'a.md', targetId: 'c.md', context: 'link 2' });
    store.insertEdge({ sourceId: 'b.md', targetId: 'a.md', context: 'backlink' });
    expect(store.countEdgesFrom('a.md')).toBe(2);
    expect(store.countEdgesTo('a.md')).toBe(1);
  });

  it('gets edge summaries (target titles without context)', () => {
    store.upsertNode({ id: 'a.md', title: 'Alpha', content: '', frontmatter: {} });
    store.upsertNode({ id: 'b.md', title: 'Beta', content: '', frontmatter: {} });
    store.upsertNode({ id: 'c.md', title: 'Gamma', content: '', frontmatter: {} });
    store.insertEdge({ sourceId: 'a.md', targetId: 'b.md', context: 'long paragraph...' });
    store.insertEdge({ sourceId: 'c.md', targetId: 'a.md', context: 'another paragraph...' });
    const outSummary = store.getEdgeSummariesFrom('a.md');
    expect(outSummary).toHaveLength(1);
    expect(outSummary[0].title).toBe('Beta');
    const inSummary = store.getEdgeSummariesTo('a.md');
    expect(inSummary).toHaveLength(1);
    expect(inSummary[0].title).toBe('Gamma');
  });

  it('FTS5 stays consistent after node update', () => {
    store.upsertNode({
      id: 'doc.md', title: 'Original', content: 'quantum mechanics', frontmatter: {},
    });
    expect(store.searchFullText('quantum').length).toBe(1);

    store.upsertNode({
      id: 'doc.md', title: 'Updated', content: 'thermodynamics', frontmatter: {},
    });
    expect(store.searchFullText('quantum')).toHaveLength(0);
    expect(store.searchFullText('thermodynamics').length).toBe(1);
    expect(store.searchFullText('thermodynamics')[0].title).toBe('Updated');
  });

  it('FTS5 cleans up after node deletion', () => {
    store.upsertNode({
      id: 'gone.md', title: 'Ephemeral', content: 'superconductor research', frontmatter: {},
    });
    expect(store.searchFullText('superconductor').length).toBe(1);
    store.deleteNode('gone.md');
    expect(store.searchFullText('superconductor')).toHaveLength(0);
  });

  it('deleteAllEdgesFrom removes only outgoing edges', () => {
    store.upsertNode({ id: 'x.md', title: 'X', content: '', frontmatter: {} });
    store.upsertNode({ id: 'y.md', title: 'Y', content: '', frontmatter: {} });
    store.insertEdge({ sourceId: 'x.md', targetId: 'y.md', context: 'x→y' });
    store.insertEdge({ sourceId: 'y.md', targetId: 'x.md', context: 'y→x' });
    store.deleteAllEdgesFrom('x.md');
    expect(store.getEdgesFrom('x.md')).toHaveLength(0);
    expect(store.getEdgesTo('x.md')).toHaveLength(1);
  });

  it('searchFullText handles FTS5 syntax errors gracefully', () => {
    store.upsertNode({
      id: 'safe.md', title: 'Safe Doc', content: 'hello world OR', frontmatter: {},
    });
    // These would throw raw FTS5 syntax errors without the fix
    const r1 = store.searchFullText('"unclosed quote');
    expect(r1).toBeInstanceOf(Array);
    const r2 = store.searchFullText('hello OR');
    expect(r2).toBeInstanceOf(Array);
  });

  it('getAllSyncPaths returns all tracked paths', () => {
    store.upsertSync('a.md', 1000);
    store.upsertSync('b.md', 2000);
    const paths = store.getAllSyncPaths();
    expect(paths).toEqual(new Set(['a.md', 'b.md']));
  });

  it('upsertCommunity and clearCommunities work correctly', () => {
    store.upsertCommunity({ id: 0, label: 'Group A', summary: '3 nodes', nodeIds: ['a.md', 'b.md', 'c.md'] });
    store.upsertCommunity({ id: 1, label: 'Group B', summary: '1 node', nodeIds: ['d.md'] });
    let communities = store.getAllCommunities();
    expect(communities).toHaveLength(2);
    expect(communities[0].nodeIds).toEqual(['a.md', 'b.md', 'c.md']);

    store.clearCommunities();
    communities = store.getAllCommunities();
    expect(communities).toHaveLength(0);
  });

  it('upsertCommunity updates existing community', () => {
    store.upsertCommunity({ id: 0, label: 'V1', summary: 'old', nodeIds: ['a.md'] });
    store.upsertCommunity({ id: 0, label: 'V2', summary: 'new', nodeIds: ['a.md', 'b.md'] });
    const communities = store.getAllCommunities();
    expect(communities).toHaveLength(1);
    expect(communities[0].label).toBe('V2');
    expect(communities[0].nodeIds).toEqual(['a.md', 'b.md']);
  });

  it('edge summaries fall back to ID when target node missing', () => {
    store.upsertNode({ id: 'src.md', title: 'Source', content: '', frontmatter: {} });
    store.insertEdge({ sourceId: 'src.md', targetId: '_stub/Missing.md', context: 'broken link' });
    const summaries = store.getEdgeSummariesFrom('src.md');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].title).toBe('_stub/Missing.md');
  });

  it('deleteNode also removes sync record', () => {
    store.upsertNode({ id: 'synced.md', title: 'Synced', content: '', frontmatter: {} });
    store.upsertSync('synced.md', 5000);
    expect(store.getSyncMtime('synced.md')).toBe(5000);
    store.deleteNode('synced.md');
    expect(store.getSyncMtime('synced.md')).toBeUndefined();
  });

  it('deleteNode removes both incoming and outgoing edges', () => {
    store.upsertNode({ id: 'a.md', title: 'A', content: '', frontmatter: {} });
    store.upsertNode({ id: 'b.md', title: 'B', content: '', frontmatter: {} });
    store.upsertNode({ id: 'c.md', title: 'C', content: '', frontmatter: {} });
    store.insertEdge({ sourceId: 'a.md', targetId: 'b.md', context: 'out' });
    store.insertEdge({ sourceId: 'c.md', targetId: 'b.md', context: 'in' });
    store.deleteNode('b.md');
    expect(store.getEdgesFrom('a.md')).toHaveLength(0);
    expect(store.getEdgesFrom('c.md')).toHaveLength(0);
  });
});
