/**
 * A single-slot promise-chain mutex for serializing async critical sections.
 *
 * The long-lived MCP server processes tool calls concurrently, and clients
 * pipeline overlapping calls (see ensure-embedder.ts). The mutating handlers
 * — kg_index, kg_create_node, kg_annotate_node, kg_add_link — each interleave
 * store reads and writes across `await` points (embedding, file I/O), so two
 * overlapping mutations corrupt state: duplicated or dropped edges, or stale
 * content stored with a post-edit mtime (finding mcp/index.ts:47). Wrapping
 * every mutating handler in one shared lock forces them to run one at a time.
 *
 * `withLock(fn)` returns fn's own result/rejection; a rejecting section never
 * wedges the chain (the next acquisition still runs).
 */
export function makeWriteLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return function withLock<T>(fn: () => Promise<T>): Promise<T> {
    // Run fn after the current tail settles, regardless of how it settled.
    const run = tail.then(fn, fn);
    // Advance the tail on a swallowed copy so one rejection can't break the lock.
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}
