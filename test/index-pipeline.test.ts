import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { Store } from '../src/lib/store.js';
import { Embedder } from '../src/lib/embedder.js';
import { IndexPipeline } from '../src/lib/index-pipeline.js';
import { VaultWriter } from '../src/lib/writer.js';

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

  // Regression (mirror of the test above, in the DELETE direction): when a
  // linked target file is deleted, deleteNode() drops the linker's A→B edge
  // wholesale, but the unchanged linker is then SKIPPED by the mtime check —
  // so its freshly-parsed `A → _stub/B.md` edge was never inserted. The link
  // silently vanished (backlinks/paths/communities lose the connection with
  // no error) while the orphan `_stub/B.md` node was still created.
  it('converts linker edges to stub edges when the linked file is deleted', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-stub-delete-'));
    const tmpStore = new Store(':memory:');
    const tmpPipeline = new IndexPipeline(tmpStore, embedder);

    try {
      // Step 1: A.md links to B.md, both exist. Pin A's mtime to a fixed
      // past second so the second pass reliably SKIPS it (see test above).
      const aPath = join(tmpVault, 'A.md');
      writeFileSync(aPath, '# A\n\nSee [[B]] for details.\n');
      writeFileSync(join(tmpVault, 'B.md'), '# B\n\nB content.\n');
      const pinnedMtime = Math.floor(Date.now() / 1000) - 3600;
      utimesSync(aPath, pinnedMtime, pinnedMtime);

      const first = await tmpPipeline.index(tmpVault);
      expect(first.nodesIndexed).toBe(2);
      expect(tmpStore.getEdgesFrom('A.md').some(e => e.targetId === 'B.md')).toBe(true);

      // Step 2: delete B.md; A.md mtime is preserved so it skips.
      rmSync(join(tmpVault, 'B.md'));
      utimesSync(aPath, pinnedMtime, pinnedMtime);

      const second = await tmpPipeline.index(tmpVault);
      expect(second.nodesIndexed).toBe(0);
      expect(second.nodesSkipped).toBe(1);

      // Step 3: A's edge MUST now point at the stub — not vanish entirely.
      const edgesAfter = tmpStore.getEdgesFrom('A.md');
      expect(edgesAfter.some(e => e.targetId === '_stub/B.md')).toBe(true);
      expect(edgesAfter.some(e => e.targetId === 'B.md')).toBe(false);
      // The stub node backs the edge so graph traversal sees it.
      expect(tmpStore.getNode('_stub/B.md')).toBeDefined();
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

  // Regression: the skip was keyed on mtime monotonically INCREASING
  // (`prevMtime >= mtime → skip`). But git checkout / cp -p restore / rsync /
  // Dropbox commonly set a CHANGED file's mtime to a value <= the recorded
  // one. Such a file was then never re-parsed — stale content, edges, and
  // embedding persisted silently while the pipeline reported nodesSkipped++
  // as if nothing was wrong. Intent: any mtime DIFFERENCE (not just an
  // increase) must trigger a re-index so backdated edits are caught.
  it('re-indexes a changed file whose mtime was backdated (git checkout / restore)', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-backdate-'));
    const tmpStore = new Store(':memory:');
    const tmpPipeline = new IndexPipeline(tmpStore, embedder);

    try {
      const aPath = join(tmpVault, 'A.md');
      // First version links to B.
      writeFileSync(aPath, '# A\n\nv1 content unique-token-alpha. See [[B]].\n');
      const t1 = Math.floor(Date.now() / 1000); // seconds precision
      utimesSync(aPath, t1, t1);

      const first = await tmpPipeline.index(tmpVault);
      expect(first.nodesIndexed).toBe(1);
      const beforeEdges = tmpStore.getEdgesFrom('A.md');
      expect(beforeEdges.some(e => e.targetId.includes('B'))).toBe(true);
      expect(tmpStore.getNode('A.md')!.content).toContain('unique-token-alpha');

      // Rewrite A with DIFFERENT content + a DIFFERENT link, then BACKDATE
      // its mtime to before the recorded mtime (simulates restoring an older
      // revision whose bytes nonetheless changed vs. the indexed version).
      writeFileSync(aPath, '# A\n\nv2 content unique-token-beta. See [[C]].\n');
      const tOld = t1 - 3600; // one hour earlier than recorded
      utimesSync(aPath, tOld, tOld);

      const second = await tmpPipeline.index(tmpVault);

      // The backdated change MUST be picked up, not silently skipped.
      expect(second.nodesSkipped).toBe(0);
      expect(second.nodesIndexed).toBe(1);
      const afterNode = tmpStore.getNode('A.md')!;
      expect(afterNode.content).toContain('unique-token-beta');
      expect(afterNode.content).not.toContain('unique-token-alpha');
      const afterEdges = tmpStore.getEdgesFrom('A.md');
      expect(afterEdges.some(e => e.targetId.includes('C'))).toBe(true);
      expect(afterEdges.some(e => e.targetId.includes('B'))).toBe(false);
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

  // Regression: edge-only stub reconciliation must rerun community detection.
  // Before the fix, the community guard was `nodesIndexed > 0 || stubNodesCreated > 0`,
  // so a run that only reconciled previously-stub edges (mtime-unchanged source)
  // left communities pointing at the pre-resolution graph — kg_communities
  // reported stale membership while kg_search saw the repaired edges.
  it('reruns community detection on edge-only stub reconciliation', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-stub-community-'));
    const tmpStore = new Store(':memory:');
    const tmpPipeline = new IndexPipeline(tmpStore, embedder);

    try {
      // Vault with three sources linking to a missing target. Multiple
      // sources sharing a stub target ensures community membership has
      // something meaningful to recompute when the stub resolves.
      const aPath = join(tmpVault, 'A.md');
      const bPath = join(tmpVault, 'B.md');
      const cPath = join(tmpVault, 'C.md');
      writeFileSync(aPath, '# A\n[[Hub]]\n');
      writeFileSync(bPath, '# B\n[[Hub]]\n');
      writeFileSync(cPath, '# C\n[[Hub]]\n');
      const pinned = Math.floor(Date.now() / 1000) - 3600;
      utimesSync(aPath, pinned, pinned);
      utimesSync(bPath, pinned, pinned);
      utimesSync(cPath, pinned, pinned);

      const first = await tmpPipeline.index(tmpVault);
      expect(first.communitiesDetected).toBeGreaterThan(0);

      // Now create the missing Hub.md AND keep A/B/C mtimes pinned so
      // they get skipped — only the stub-reconciliation pass should run.
      writeFileSync(join(tmpVault, 'Hub.md'), '# Hub\nContent.\n');
      utimesSync(aPath, pinned, pinned);
      utimesSync(bPath, pinned, pinned);
      utimesSync(cPath, pinned, pinned);

      const second = await tmpPipeline.index(tmpVault);
      // Only Hub was newly indexed; A/B/C were skipped — but the
      // reconciliation pass mutated their edges, so communities must rerun.
      expect(second.nodesIndexed).toBe(1);
      expect(second.communitiesDetected).toBeGreaterThan(0);
    } finally {
      tmpStore.close();
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  // Regression (finding cli/index.ts:57): `kg index --force` used to
  // `DELETE FROM sync` before indexing, which emptied `previousPaths` and
  // thereby DISABLED deleted-file detection — a note removed from the vault
  // kept its node/edges/embedding forever and reappeared in every search.
  // The fix threads a `force` flag that bypasses the mtime skip WITHOUT wiping
  // sync, so a forced full rebuild still reconciles deletions. This test bites
  // both halves: `nodesSkipped === 0` proves force re-indexes everything (the
  // pre-fix signature ignored the arg → the surviving file would be skipped),
  // and the orphan-cleanup assertion fails if anyone reintroduces the sync
  // wipe in the force path.
  it('force re-index bypasses the mtime skip yet still cleans up deleted files', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-force-cleanup-'));
    const tmpStore = new Store(':memory:');
    const tmpPipeline = new IndexPipeline(tmpStore, embedder);

    try {
      writeFileSync(join(tmpVault, 'Keep.md'), '# Keep\n\nkeep content.\n');
      writeFileSync(join(tmpVault, 'Gone.md'), '# Gone\n\ngone content.\n');
      await tmpPipeline.index(tmpVault);
      expect(tmpStore.getNode('Gone.md')).toBeDefined();

      // Delete a file from the vault, then force a full rebuild.
      rmSync(join(tmpVault, 'Gone.md'));
      const stats = await tmpPipeline.index(tmpVault, 1.0, true);

      // force must re-index the surviving file, not skip it (pre-fix code
      // ignored the flag and would report nodesSkipped === 1).
      expect(stats.nodesSkipped).toBe(0);
      expect(stats.nodesIndexed).toBe(1);

      // The deleted file's node/edges must be gone — no searchable orphan.
      expect(tmpStore.getNode('Gone.md')).toBeUndefined();
      expect(tmpStore.allNodeIds()).not.toContain('Gone.md');
      // sync was NOT wiped: it now tracks the surviving file (and only it).
      expect([...tmpStore.getAllSyncPaths()]).toEqual(['Keep.md']);
    } finally {
      tmpStore.close();
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  // Regression (finding writer.ts:218): addLink resolves its target with
  // resolveNodeName (title/alias/substring), but a subsequent full `kg index`
  // re-resolves the written link with resolveLink (filename-stem/path only).
  // For a note whose title ≠ filename stem the two disagreed, so the real edge
  // addLink created was SILENTLY replaced by a `_stub/<title>.md` edge on the
  // next index — the real node lost its backlink with no error. The fix writes
  // a path-qualified link so both resolvers agree.
  it('addLink by title survives a full re-index without retargeting to a stub', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-addlink-retarget-'));
    const tmpStore = new Store(':memory:');
    const tmpPipeline = new IndexPipeline(tmpStore, embedder);

    try {
      // Target's filename STEM (wt) differs from its frontmatter TITLE.
      mkdirSync(join(tmpVault, 'notes'), { recursive: true });
      writeFileSync(join(tmpVault, 'notes', 'wt.md'), '---\ntitle: Widget Theory\n---\n# WT\n\nbody\n');
      writeFileSync(join(tmpVault, 'source.md'), '# Source\n\nbody\n');
      await tmpPipeline.index(tmpVault);

      // addLink by TITLE — resolves to the real node notes/wt.md.
      const writer = new VaultWriter(tmpVault, tmpStore);
      await writer.addLink('source.md', 'Widget Theory', 'see also');
      expect(tmpStore.getEdgesFrom('source.md').some(e => e.targetId === 'notes/wt.md')).toBe(true);

      // Force a full re-index (deterministic reparse regardless of mtime
      // granularity). The written link must re-resolve to the SAME real node.
      await tmpPipeline.index(tmpVault, 1.0, true);
      const edges = tmpStore.getEdgesFrom('source.md');
      expect(edges.some(e => e.targetId === 'notes/wt.md')).toBe(true);
      expect(edges.some(e => e.targetId.startsWith('_stub/'))).toBe(false);
      expect(tmpStore.getNode('_stub/Widget Theory.md')).toBeUndefined();
    } finally {
      tmpStore.close();
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  // Regression (finding writer.ts:218): the common MCP pattern where Claude
  // links several notes to a concept that does not exist yet. Each addLink to
  // the same unresolvable target must survive a full re-index as ONE shared
  // stub — not fragment into a double-nested `_stub/_stub/…` stub for every
  // call after the first. Pre-fix, the 2nd+ addLink wrote `[[_stub/Concept]]`,
  // which reparsed to a distinct `_stub/_stub/Concept.md` node.
  it('links from two sources to the same unresolved target share one stub across a full re-index', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-addlink-sharedstub-'));
    const tmpStore = new Store(':memory:');
    const tmpPipeline = new IndexPipeline(tmpStore, embedder);

    try {
      writeFileSync(join(tmpVault, 'alpha.md'), '# Alpha\n\nbody\n');
      writeFileSync(join(tmpVault, 'beta.md'), '# Beta\n\nbody\n');
      await tmpPipeline.index(tmpVault);

      const writer = new VaultWriter(tmpVault, tmpStore);
      // Both sources link to a concept with no backing file.
      await writer.addLink('alpha.md', 'FutureConcept', 'see also');
      await writer.addLink('beta.md', 'FutureConcept', 'related');

      // Force a full re-index (deterministic reparse regardless of mtime).
      await tmpPipeline.index(tmpVault, 1.0, true);

      // Every edge from either source targets the single parser-shaped stub.
      const allEdges = [
        ...tmpStore.getEdgesFrom('alpha.md'),
        ...tmpStore.getEdgesFrom('beta.md'),
      ];
      expect(allEdges.length).toBeGreaterThan(0);
      expect(allEdges.every(e => e.targetId === '_stub/FutureConcept.md')).toBe(true);

      // Exactly one stub, and no double-nested stub leaked in.
      const stubs = tmpStore.allNodeIds().filter(id => id.startsWith('_stub/'));
      expect(stubs).toEqual(['_stub/FutureConcept.md']);
      expect(tmpStore.allNodeIds().some(id => id.startsWith('_stub/_stub/'))).toBe(false);
    } finally {
      tmpStore.close();
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  // Finding #34: clearCommunities + upsertCommunity loop is not atomic.
  // Without a transaction wrapper, a throw inside upsertCommunity (e.g. a
  // SIGKILL arriving between the committed DELETE and a mid-loop INSERT in WAL
  // mode) leaves the communities table empty or partially populated. Every
  // subsequent `kg_central --community N` call then fails with "Community N
  // not found" for any community whose INSERT was never committed.
  // Intent: the swap must be all-or-nothing: either all new communities land or
  // the old set is preserved intact, never an empty/partial intermediate state.
  it('community swap is atomic — a throw mid-loop preserves old communities, not empty/partial state', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-community-atomic-'));
    const tmpStore = new Store(':memory:');
    const tmpPipeline = new IndexPipeline(tmpStore, embedder);

    try {
      // Three-node triangle: guaranteed to yield at least one community.
      writeFileSync(join(tmpVault, 'A.md'), '# A\n[[B]]\n[[C]]\n');
      writeFileSync(join(tmpVault, 'B.md'), '# B\n[[A]]\n[[C]]\n');
      writeFileSync(join(tmpVault, 'C.md'), '# C\n[[A]]\n[[B]]\n');

      // First run: establish a known community set.
      await tmpPipeline.index(tmpVault);
      const oldCommunities = tmpStore.getAllCommunities();
      expect(oldCommunities.length).toBeGreaterThan(0);
      const oldIds = oldCommunities.map(c => c.id).sort((a, b) => a - b);

      // Patch upsertCommunity to throw on the very first call, simulating a
      // crash that arrives after clearCommunities() has committed its DELETE
      // but before any INSERT completes (the worst-case partial-state scenario).
      let callCount = 0;
      const origUpsert = tmpStore.upsertCommunity.bind(tmpStore);
      tmpStore.upsertCommunity = (c: Parameters<typeof tmpStore.upsertCommunity>[0]) => {
        if (++callCount === 1) throw new Error('simulated mid-loop crash');
        origUpsert(c);
      };

      // Add a new file so nodesIndexed > 0, forcing community re-detection.
      writeFileSync(join(tmpVault, 'D.md'), '# D\n[[A]]\n');

      // Second run: index() must reject because upsertCommunity throws.
      await expect(tmpPipeline.index(tmpVault)).rejects.toThrow('simulated mid-loop crash');

      // After the failed swap the communities table must still reflect the OLD
      // set — not be empty (crash after DELETE, before first INSERT).
      // Without the transaction fix, getAllCommunities() returns [] here because
      // clearCommunities() already committed its DELETE before the throw.
      const afterIds = tmpStore.getAllCommunities().map(c => c.id).sort((a, b) => a - b);
      expect(afterIds).toEqual(oldIds);
    } finally {
      tmpStore.close();
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  // Regression (finding index-pipeline.ts:188): stub titles were derived with
  // String.replace('.md', '') which removes the FIRST '.md' substring, not the
  // extension. A ref like [[notes.mdx]] yields stub id `_stub/notes.mdx.md`
  // whose title was mangled to 'notesx.md' instead of 'notes.mdx'.
  it('derives a stub node title by stripping only the trailing .md extension', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-stub-title-'));
    const tmpStore = new Store(':memory:');
    const tmpPipeline = new IndexPipeline(tmpStore, embedder);
    try {
      writeFileSync(join(tmpVault, 'note.md'), '# Note\n\nSee [[notes.mdx]] for details.\n');
      await tmpPipeline.index(tmpVault);
      const stub = tmpStore.getNode('_stub/notes.mdx.md');
      expect(stub).toBeDefined();
      expect(stub!.title).toBe('notes.mdx');
    } finally {
      tmpStore.close();
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  // Regression (finding index-pipeline.ts:201): a deletion-only run — the
  // deleted note has NO inbound links and every other file is mtime-skipped —
  // used to leave communities untouched (the gate only checked
  // nodesIndexed/stubNodesCreated/edgeTopologyChanged). kg_communities then
  // served membership still listing the deleted node.
  it('recomputes communities on a deletion-only run and drops the deleted node', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-del-community-'));
    const tmpStore = new Store(':memory:');
    const tmpPipeline = new IndexPipeline(tmpStore, embedder);
    try {
      // X links OUT to Y and Z but nothing links to X (no backlinks).
      const xPath = join(tmpVault, 'X.md');
      const yPath = join(tmpVault, 'Y.md');
      const zPath = join(tmpVault, 'Z.md');
      writeFileSync(xPath, '# X\n\n[[Y]] and [[Z]]\n');
      writeFileSync(yPath, '# Y\n\n[[Z]]\n');
      writeFileSync(zPath, '# Z\n\nleaf\n');
      const pinned = Math.floor(Date.now() / 1000) - 3600;
      utimesSync(xPath, pinned, pinned);
      utimesSync(yPath, pinned, pinned);
      utimesSync(zPath, pinned, pinned);

      await tmpPipeline.index(tmpVault);
      expect(tmpStore.getAllCommunities().some(c => c.nodeIds.includes('X.md'))).toBe(true);

      // Delete X only; Y and Z stay pinned so the run is deletion-only.
      rmSync(xPath);
      utimesSync(yPath, pinned, pinned);
      utimesSync(zPath, pinned, pinned);

      const stats = await tmpPipeline.index(tmpVault);
      expect(stats.nodesIndexed).toBe(0);
      expect(stats.communitiesDetected).toBeGreaterThan(0);
      expect(tmpStore.getAllCommunities().some(c => c.nodeIds.includes('X.md'))).toBe(false);
    } finally {
      tmpStore.close();
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  // Regression (finding index-pipeline.ts:41): deletion detection was driven
  // solely by the sync table, but VaultWriter.indexFile (kg_create_node) never
  // writes a sync row. A node created via the writer and then deleted from disk
  // was absent from BOTH previousPaths and currentPaths, so no run ever removed
  // it — a ghost surfacing in search forever.
  it('removes a writer-created node whose file was deleted before the next pipeline run', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-ghost-'));
    const tmpStore = new Store(':memory:');
    const tmpWriter = new VaultWriter(tmpVault, tmpStore, embedder);
    const tmpPipeline = new IndexPipeline(tmpStore, embedder);
    try {
      await tmpWriter.createNode({ title: 'Ghost', frontmatter: {}, content: 'ghostbody uniquetoken' });
      expect(tmpStore.getNode('Ghost.md')).toBeDefined();
      // Writer path wrote no sync row.
      expect([...tmpStore.getAllSyncPaths()]).not.toContain('Ghost.md');

      rmSync(join(tmpVault, 'Ghost.md'));
      await tmpPipeline.index(tmpVault);

      expect(tmpStore.getNode('Ghost.md')).toBeUndefined();
      expect(tmpStore.searchFullText('uniquetoken')).toHaveLength(0);
    } finally {
      tmpStore.close();
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  // Regression (finding index-pipeline.ts:66): the deletion loop deleted the
  // target node + its linkers' edges at the START of index(), but the
  // compensating re-insertion of `A → _stub/B.md` edges happened only AFTER the
  // whole embedding loop, in process memory. A crash mid-run committed the
  // deletion but lost the reconciliation, and the next run could not recover
  // (B gone from sync, A mtime-skipped) — the link vanished permanently.
  it('recovers a linker stub edge after a crash between deletion and reconciliation', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-crash-'));
    const tmpStore = new Store(':memory:');
    const goodPipeline = new IndexPipeline(tmpStore, embedder);
    const throwingEmbedder = {
      embed: async () => { throw new Error('simulated crash'); },
    } as unknown as Embedder;
    const crashPipeline = new IndexPipeline(tmpStore, throwingEmbedder);
    try {
      const aPath = join(tmpVault, 'A.md');
      writeFileSync(aPath, '# A\n\nSee [[B]].\n');
      writeFileSync(join(tmpVault, 'B.md'), '# B\n\nB body.\n');
      const pinned = Math.floor(Date.now() / 1000) - 3600;
      utimesSync(aPath, pinned, pinned);

      await goodPipeline.index(tmpVault);
      expect(tmpStore.getEdgesFrom('A.md').some(e => e.targetId === 'B.md')).toBe(true);

      // Delete B, add a NEW file C whose embed throws (mid-run kill), keep A pinned.
      rmSync(join(tmpVault, 'B.md'));
      writeFileSync(join(tmpVault, 'C.md'), '# C\n\nnew file.\n');
      utimesSync(aPath, pinned, pinned);

      await expect(crashPipeline.index(tmpVault)).rejects.toThrow('simulated crash');

      // Re-run with a working embedder — the graph must converge: A's link to
      // the deleted B survives as a stub edge, not vanish.
      utimesSync(aPath, pinned, pinned);
      await goodPipeline.index(tmpVault);

      const edges = tmpStore.getEdgesFrom('A.md');
      expect(edges.some(e => e.targetId === '_stub/B.md')).toBe(true);
      expect(edges.some(e => e.targetId === 'B.md')).toBe(false);
      expect(tmpStore.getNode('_stub/B.md')).toBeDefined();
    } finally {
      tmpStore.close();
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  // Regression (finding index-pipeline.ts:100): per-file mutations (upsertNode,
  // upsertEmbedding, deleteAllEdgesFrom, insertEdge×N, upsertSync) ran as
  // separate autocommit statements. A throw mid-way left a half-updated node
  // (new content, some edges deleted, others not inserted) visible to readers.
  // Wrapping them in one transaction makes the per-file update all-or-nothing.
  it('rolls back the whole per-file update when an edge insert throws mid-way', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-atomic-file-'));
    const tmpStore = new Store(':memory:');
    const tmpPipeline = new IndexPipeline(tmpStore, embedder);
    try {
      const nPath = join(tmpVault, 'N.md');
      writeFileSync(nPath, '# N\n\nv1token. See [[X]].\n');
      writeFileSync(join(tmpVault, 'X.md'), '# X\n');
      writeFileSync(join(tmpVault, 'Y.md'), '# Y\n');
      writeFileSync(join(tmpVault, 'Z.md'), '# Z\n');
      await tmpPipeline.index(tmpVault);
      expect(tmpStore.getNode('N.md')!.content).toContain('v1token');
      expect(tmpStore.getEdgesFrom('N.md').map(e => e.targetId)).toEqual(['X.md']);

      // Change N: new content + two new links; make the 2nd edge insert throw.
      writeFileSync(nPath, '# N\n\nv2token. See [[Y]] and [[Z]].\n');
      let nEdgeCalls = 0;
      const origInsert = tmpStore.insertEdge.bind(tmpStore);
      tmpStore.insertEdge = (edge: Parameters<typeof origInsert>[0]) => {
        if (edge.sourceId === 'N.md' && ++nEdgeCalls === 2) {
          throw new Error('boom on 2nd edge');
        }
        return origInsert(edge);
      };
      try {
        await expect(tmpPipeline.index(tmpVault)).rejects.toThrow('boom on 2nd edge');
      } finally {
        tmpStore.insertEdge = origInsert;
      }

      // The entire per-file update must have rolled back to the OLD state.
      const n = tmpStore.getNode('N.md')!;
      expect(n.content).toContain('v1token');
      expect(n.content).not.toContain('v2token');
      expect(tmpStore.getEdgesFrom('N.md').map(e => e.targetId)).toEqual(['X.md']);
    } finally {
      tmpStore.close();
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  // Regression (finding config.ts:35): dbPath is derived from dataDir alone, so
  // two different vaults sharing the default KG_DATA_DIR resolve to the SAME
  // kg.db. Indexing vault B then treats every path of vault A as deleted and
  // silently destroys A's index. The DB must record its vault identity and fail
  // loud on a mismatch.
  it('refuses to index a second vault into a DB already bound to another vault', async () => {
    const vaultA = mkdtempSync(join(tmpdir(), 'kg-vaultA-'));
    const vaultB = mkdtempSync(join(tmpdir(), 'kg-vaultB-'));
    const sharedStore = new Store(':memory:');
    const pipe = new IndexPipeline(sharedStore, embedder);
    try {
      writeFileSync(join(vaultA, 'a.md'), '# A\n\nalpha\n');
      writeFileSync(join(vaultB, 'b.md'), '# B\n\nbeta\n');

      await pipe.index(vaultA);
      expect(sharedStore.getNode('a.md')).toBeDefined();

      await expect(pipe.index(vaultB)).rejects.toThrow(/vault/i);
      // Vault A's index must be intact; vault B must not have been indexed.
      expect(sharedStore.getNode('a.md')).toBeDefined();
      expect(sharedStore.getNode('b.md')).toBeUndefined();
    } finally {
      sharedStore.close();
      rmSync(vaultA, { recursive: true, force: true });
      rmSync(vaultB, { recursive: true, force: true });
    }
  });
});
