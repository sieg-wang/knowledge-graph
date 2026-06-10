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

  // Regression: a REJECTED init() promise stayed cached in the gate, so one
  // transient failure (first-run model download with network down, disk full
  // in the HF cache) rethrew the original error on EVERY later call — the
  // MCP server is long-lived, so kg_index/kg_search stayed dead for the whole
  // session even after the cause was fixed. A failed init must clear the
  // gate so the next call retries.
  it('retries init after a failed init instead of caching the rejection', async () => {
    let initCount = 0;
    const embedder = {
      init: () => {
        initCount++;
        return initCount === 1
          ? Promise.reject(new Error('model download failed'))
          : Promise.resolve();
      },
    };

    const ensure = makeEnsureEmbedder(embedder);

    await expect(ensure()).rejects.toThrow('model download failed');
    expect(initCount).toBe(1);

    // The cause is fixed (second init succeeds) — the gate must retry...
    await expect(ensure()).resolves.toBeUndefined();
    expect(initCount).toBe(2);

    // ...and the SUCCESS stays cached as before (no third init).
    await ensure();
    expect(initCount).toBe(2);
  });

  it('rejects all concurrent callers of a failing init, then allows retry', async () => {
    let initCount = 0;
    let rejectInit!: (e: Error) => void;
    const failing = new Promise<void>((_, rej) => { rejectInit = rej; });
    const embedder = {
      init: () => {
        initCount++;
        return initCount === 1 ? failing : Promise.resolve();
      },
    };
    const ensure = makeEnsureEmbedder(embedder);

    // Two callers race onto the SAME failing attempt — both must see the
    // rejection (one shared init, not two), and the failure must not poison
    // the gate for the retry afterwards.
    const p1 = ensure();
    const p2 = ensure();
    expect(initCount).toBe(1);

    rejectInit(new Error('boom'));
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).rejects.toThrow('boom');

    await expect(ensure()).resolves.toBeUndefined();
    expect(initCount).toBe(2);
  });
});
