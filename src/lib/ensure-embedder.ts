/**
 * Concurrency-safe one-time embedder initialization.
 *
 * The MCP server lazily inits the embedder on the first kg_index / kg_search.
 * The previous gate was a boolean flipped AFTER the await:
 *
 *   if (!embedderReady) { await embedder.init(); embedderReady = true; }
 *
 * A second tool call arriving while the first init's `await embedder.init()`
 * was still in flight saw `embedderReady === false` and called init() AGAIN —
 * Embedder.init reassigns `this.extractor`, so the model was downloaded/loaded
 * twice (doubled memory + CPU, the first pipeline orphaned with no dispose).
 * MCP stdio is usually serial so this was latent, but a client that pipelines
 * requests (or kg_index + kg_search back-to-back) triggered it.
 *
 * Sharing a single in-flight promise collapses all concurrent callers onto one
 * init: the FIRST call kicks off init() and caches the promise; every later
 * caller awaits the same promise instead of starting a second init.
 */
export interface EmbedderLike {
  init(): Promise<void>;
}

export function makeEnsureEmbedder(embedder: EmbedderLike): () => Promise<void> {
  let initPromise: Promise<void> | null = null;
  return () => (initPromise ??= embedder.init().catch(err => {
    // A REJECTED promise must NOT stay cached: one transient init failure
    // (first-run model download with network down, disk full in the HF
    // cache) would otherwise rethrow on every later call for the whole
    // long-lived MCP server session. Clear the gate so the next call
    // retries; concurrent callers of THIS attempt still share the single
    // rejection.
    initPromise = null;
    throw err;
  }));
}
