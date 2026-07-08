/**
 * Regression (finding index-pipeline.ts:82): TOCTOU between content read and
 * mtime capture. parseVault reads a file's CONTENT up front, but the mtime the
 * pipeline persisted into `sync` used to be stat'd LATER inside the per-node
 * loop — after seconds-to-minutes of embedding awaits. A note edited in that
 * window had its POST-edit mtime stored alongside its PRE-edit content, so
 * every later run saw prevMtime === mtime and SKIPPED it: stale content, edges
 * and embedding survived forever.
 *
 * The fix captures the mtime at read time in parseVault and threads it on
 * ParsedNode.mtimeMs; index() uses that content-snapshot mtime for both the
 * skip check and upsertSync. We drive the seam by mocking parseVault for the
 * first run so the recorded content pairs with an OLD snapshot mtime while the
 * on-disk file already carries newer content at a DIFFERENT mtime.
 */
import { describe, it, expect, vi } from 'vitest';
import { join } from 'path';
import { mkdtempSync, writeFileSync, rmSync, utimesSync, statSync } from 'fs';
import { tmpdir } from 'os';

// Default the mock to the REAL parseVault; individual runs override once.
vi.mock('../src/lib/parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/parser.js')>();
  return { ...actual, parseVault: vi.fn(actual.parseVault) };
});

import { Store } from '../src/lib/store.js';
import { Embedder } from '../src/lib/embedder.js';
import { IndexPipeline } from '../src/lib/index-pipeline.js';
import { parseVault } from '../src/lib/parser.js';

// Stub embedder — the pipeline only calls embed(); avoids loading the model.
const stubEmbedder = { embed: async () => new Float32Array(384) } as unknown as Embedder;

describe('IndexPipeline TOCTOU (content vs mtime)', () => {
  it('re-indexes a file whose content changed during a prior run (mtime matched pre-edit snapshot)', async () => {
    const store = new Store(':memory:');
    const pipeline = new IndexPipeline(store, stubEmbedder);
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-toctou-'));

    try {
      // On-disk truth: NEW content at a fixed mtime M_fixed.
      const aPath = join(tmpVault, 'A.md');
      writeFileSync(aPath, '# A\n\nNEW content on disk marker-new.\n');
      const mFixed = Math.floor(Date.now() / 1000) - 100; // seconds precision
      utimesSync(aPath, mFixed, mFixed);
      const mFixedMs = statSync(aPath).mtimeMs;

      // Run 1: simulate the pipeline having read OLD content at an OLDER
      // snapshot mtime (M_old), even though the file on disk is already NEW at
      // M_fixed. The BUGGY pipeline ignores the snapshot mtime and stat()s the
      // live file → records M_fixed with the OLD content.
      vi.mocked(parseVault).mockImplementationOnce(async () => ({
        nodes: [{
          id: 'A.md',
          title: 'A',
          content: '# A\n\nOLD content marker-old.\n',
          frontmatter: {},
          mtimeMs: mFixedMs - 3_600_000, // one hour earlier than the on-disk mtime
        }],
        edges: [],
        stubIds: new Set<string>(),
      }));

      await pipeline.index(tmpVault);
      expect(store.getNode('A.md')!.content).toContain('marker-old');

      // Run 2: real parseVault reads NEW content at M_fixed.
      // BUGGY: sync mtime from run 1 == M_fixed == run-2 mtime → SKIP → stale.
      // FIXED: run 1 stored the OLD snapshot mtime → differs from M_fixed →
      // re-index → NEW content lands.
      const second = await pipeline.index(tmpVault);

      expect(store.getNode('A.md')!.content).toContain('marker-new');
      expect(store.getNode('A.md')!.content).not.toContain('marker-old');
      expect(second.nodesSkipped).toBe(0);
    } finally {
      store.close();
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });
});
