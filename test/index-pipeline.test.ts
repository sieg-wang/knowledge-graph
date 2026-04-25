import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { Store } from '../src/lib/store.js';
import { Embedder } from '../src/lib/embedder.js';
import { IndexPipeline } from '../src/lib/index-pipeline.js';

const FIXTURE_VAULT = join(import.meta.dirname, 'fixtures', 'vault');

describe('IndexPipeline', () => {
  let store: Store;
  let embedder: Embedder;
  let pipeline: IndexPipeline;

  beforeAll(async () => {
    store = new Store(':memory:');
    embedder = new Embedder();
    await embedder.init();
    pipeline = new IndexPipeline(store, embedder);
  }, 60000);

  afterAll(async () => {
    store.close();
    await embedder.dispose();
  });

  it('indexes the fixture vault', async () => {
    const stats = await pipeline.index(FIXTURE_VAULT);
    expect(stats.nodesIndexed).toBeGreaterThan(0);
    expect(stats.edgesIndexed).toBeGreaterThan(0);

    const alice = store.getNode('People/Alice Smith.md');
    expect(alice).toBeDefined();
    expect(alice!.title).toBe('Alice Smith');

    const edges = store.getEdgesFrom('People/Alice Smith.md');
    expect(edges.length).toBeGreaterThan(0);
  });

  it('creates stub nodes for broken links', async () => {
    // Store retains state from the first test's index() call
    const edges = store.getEdgesFrom('Ideas/Acme Project.md');
    const stubEdge = edges.find(e => e.targetId.includes('Nonexistent'));
    expect(stubEdge).toBeDefined();
  });

  it('detects communities', async () => {
    // Communities were detected during the first test's index() call
    const communities = store.getAllCommunities();
    expect(communities.length).toBeGreaterThan(0);
  });

  it('is incremental (skips unchanged files)', async () => {
    // Use a fresh store/pipeline so the first call indexes everything
    const freshStore = new Store(':memory:');
    const freshPipeline = new IndexPipeline(freshStore, embedder);

    const first = await freshPipeline.index(FIXTURE_VAULT);
    expect(first.nodesIndexed).toBeGreaterThan(0);

    const second = await freshPipeline.index(FIXTURE_VAULT);
    expect(second.nodesIndexed).toBe(0);
    expect(second.nodesSkipped).toBe(first.nodesIndexed);

    freshStore.close();
  });

  // Regression: stub edges must be reconciled when the previously-missing
  // target file is later created. Previously, the unchanged source file was
  // skipped, leaving a stale `source → _stub/target.md` edge in the DB and
  // never inserting the resolved `source → target.md` edge.
  it('reconciles stub edges when missing targets are created later', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-stub-resolve-'));
    const tmpStore = new Store(':memory:');
    const tmpPipeline = new IndexPipeline(tmpStore, embedder);

    try {
      // Step 1: A.md links to nonexistent B.md → stub edge expected.
      // Pin A's mtime to a fixed past second so the second pass can SKIP it
      // reliably (Node's `utimesSync` uses second precision, which would
      // otherwise truncate the recorded mtimeMs and trigger a re-index).
      const aPath = join(tmpVault, 'A.md');
      writeFileSync(aPath, '# A\n\nSee [[B]] for details.\n');
      const pinnedMtime = Math.floor(Date.now() / 1000) - 3600;
      utimesSync(aPath, pinnedMtime, pinnedMtime);

      const first = await tmpPipeline.index(tmpVault);
      expect(first.nodesIndexed).toBe(1);
      expect(first.stubNodesCreated).toBeGreaterThan(0);

      // Verify A → _stub/B.md edge exists
      const edgesBefore = tmpStore.getEdgesFrom('A.md');
      const stubEdgeBefore = edgesBefore.find(e => e.targetId.startsWith('_stub/'));
      expect(stubEdgeBefore).toBeDefined();
      expect(stubEdgeBefore!.targetId).toContain('B');

      // Verify the stub node exists
      expect(tmpStore.getNode(stubEdgeBefore!.targetId)).toBeDefined();

      // Step 2: Create B.md and re-index. A.md mtime is preserved so it skips.
      const bPath = join(tmpVault, 'B.md');
      writeFileSync(bPath, '# B\n\nB content.\n');
      utimesSync(aPath, pinnedMtime, pinnedMtime);

      const second = await tmpPipeline.index(tmpVault);
      // Only B was newly indexed; A was skipped (mtime unchanged)
      expect(second.nodesIndexed).toBe(1);
      expect(second.nodesSkipped).toBe(1);

      // Step 3: A's edge MUST now point to B.md, not _stub/B.md
      const edgesAfter = tmpStore.getEdgesFrom('A.md');
      const realEdge = edgesAfter.find(e => e.targetId === 'B.md');
      expect(realEdge).toBeDefined();

      const stubEdgeAfter = edgesAfter.find(e => e.targetId.startsWith('_stub/'));
      expect(stubEdgeAfter).toBeUndefined();

      // Step 4: orphaned stub node must be deleted
      expect(tmpStore.getNode(stubEdgeBefore!.targetId)).toBeUndefined();
    } finally {
      tmpStore.close();
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  it('does not double-process sources that were already re-indexed this run', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-stub-no-double-'));
    const tmpStore = new Store(':memory:');
    const tmpPipeline = new IndexPipeline(tmpStore, embedder);

    try {
      // A.md links to B.md (missing → stub)
      const aPath = join(tmpVault, 'A.md');
      writeFileSync(aPath, '# A\n[[B]]\n');
      await tmpPipeline.index(tmpVault);

      // Modify A.md AND create B.md in the same run.
      // A is re-indexed via the normal path → its edges already point to B.md.
      // The stub-resolution pass must NOT re-touch A.
      writeFileSync(aPath, '# A (updated)\n[[B]]\n');
      writeFileSync(join(tmpVault, 'B.md'), '# B\n');

      const stats = await tmpPipeline.index(tmpVault);
      // Both A (changed) and B (new) indexed, no skips
      expect(stats.nodesIndexed).toBe(2);

      // Final state: A → B.md exists, no stub
      const edges = tmpStore.getEdgesFrom('A.md');
      expect(edges.find(e => e.targetId === 'B.md')).toBeDefined();
      expect(edges.find(e => e.targetId.startsWith('_stub/'))).toBeUndefined();
    } finally {
      tmpStore.close();
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  it('leaves still-broken stub edges intact', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-stub-leave-'));
    const tmpStore = new Store(':memory:');
    const tmpPipeline = new IndexPipeline(tmpStore, embedder);

    try {
      // A links to B (missing); B stays missing across two runs.
      writeFileSync(join(tmpVault, 'A.md'), '# A\n[[B]]\n');
      await tmpPipeline.index(tmpVault);
      const after2 = await tmpPipeline.index(tmpVault);
      expect(after2.nodesSkipped).toBe(1);

      // Stub edge and stub node must persist
      const edges = tmpStore.getEdgesFrom('A.md');
      const stubEdge = edges.find(e => e.targetId.startsWith('_stub/'));
      expect(stubEdge).toBeDefined();
      expect(tmpStore.getNode(stubEdge!.targetId)).toBeDefined();
    } finally {
      tmpStore.close();
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });
});
