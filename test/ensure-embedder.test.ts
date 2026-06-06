import { describe, it, expect } from 'vitest';
import { makeEnsureEmbedder } from '../src/lib/ensure-embedder.js';

describe('ensureEmbedder (concurrency-safe init gate)', () => {
  // Regression: the old boolean-after-await gate let a second concurrent caller
  // re-run init() while the first init was still in flight, loading the model
  // twice. The shared-promise gate must call init() exactly once even when two
  // callers race before the first init resolves.
  it('calls init exactly once under concurrent first calls', async () => {
    let initCount = 0;
    let resolveInit!: () => void;
    const slowInit = new Promise<void>((r) => { resolveInit = r; });
    const embedder = {
      init: () => {
        initCount++;
        return slowInit; // stays pending so a second caller can interleave
      },
    };

    const ensure = makeEnsureEmbedder(embedder);

    // Two callers race while init() has not yet resolved.
    const p1 = ensure();
    const p2 = ensure();
    expect(initCount).toBe(1);

    resolveInit();
    await Promise.all([p1, p2]);

    // A later call after init has resolved must NOT re-init.
    await ensure();
    expect(initCount).toBe(1);
  });

  it('returns the same in-flight promise to concurrent callers', async () => {
    const embedder = { init: () => Promise.resolve() };
    const ensure = makeEnsureEmbedder(embedder);
    const a = ensure();
    const b = ensure();
    expect(a).toBe(b);
    await Promise.all([a, b]);
  });
});
