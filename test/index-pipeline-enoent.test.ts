/**
 * MAJOR-4 regression test: stat() ENOENT must not abort the entire index run.
 *
 * index-pipeline.ts calls `stat(join(vaultPath, node.id))` for each file in
 * parseVault's snapshot. A file deleted between parseVault() and the stat loop
 * (e.g. by a sync client, concurrent process, or the user) used to propagate
 * uncaught, leaving the store in a partially-updated state. The fix wraps stat
 * in a try-catch that increments nodesSkipped and continues.
 *
 * We use vi.mock to inject the ENOENT without relying on real filesystem races.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

// --- stat mock setup (must be before any import that pulls in index-pipeline) ---

// statMockTarget: when set to a filename suffix, the next stat call matching
// that path throws ENOENT once, then resets. All other calls pass through.
let statMockTarget: string | null = null;

vi.mock('fs/promises', async (importOriginal) => {
  const mod = await importOriginal<typeof import('fs/promises')>();
  return {
    ...mod,
    stat: vi.fn().mockImplementation(async (p: unknown, ...rest: unknown[]) => {
      if (statMockTarget && String(p).endsWith(statMockTarget)) {
        statMockTarget = null; // fire once
        const err = Object.assign(new Error(`ENOENT: no such file or directory, stat '${p}'`), {
          code: 'ENOENT',
        });
        throw err;
      }
      return mod.stat(p as any, ...(rest as any[]));
    }),
  };
});

// Imports must come AFTER the vi.mock call so the mock is active.
import { Store } from '../src/lib/store.js';
import { Embedder } from '../src/lib/embedder.js';
import { IndexPipeline } from '../src/lib/index-pipeline.js';

describe('IndexPipeline ENOENT handling (MAJOR-4)', () => {
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

  it('skips a file that disappears between parseVault and stat, and continues indexing survivors', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-enoent-'));

    try {
      writeFileSync(join(tmpVault, 'Alive.md'), '# Alive\nThis one survives.\n', 'utf-8');
      writeFileSync(join(tmpVault, 'Gone.md'), '# Gone\nThis one disappears.\n', 'utf-8');

      // Trigger the mock to throw ENOENT when stat() is called for Gone.md.
      // This simulates the file being deleted BETWEEN parseVault (which lists
      // it) and the stat loop in index-pipeline.ts.
      statMockTarget = 'Gone.md';

      const stats = await pipeline.index(tmpVault);

      // Alive.md must be indexed; Gone.md must be counted as skipped, not crashed.
      expect(stats.nodesIndexed).toBe(1);
      expect(stats.nodesSkipped).toBe(1);

      // Alive.md must be findable in the store.
      const alive = store.getNode('Alive.md');
      expect(alive).toBeDefined();
      expect(alive!.title).toBe('Alive');

      // Gone.md should NOT be in the store (it was skipped before upsertNode).
      expect(store.getNode('Gone.md')).toBeUndefined();
    } finally {
      statMockTarget = null;
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });
});
