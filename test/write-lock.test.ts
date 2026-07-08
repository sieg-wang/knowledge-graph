/**
 * The MCP server's mutating tool handlers (kg_index / kg_create_node /
 * kg_annotate_node / kg_add_link) interleave reads/writes across await points;
 * clients pipeline overlapping calls, corrupting store state — duplicated or
 * dropped edges, stale content (finding mcp/index.ts:47). makeWriteLock is the
 * single-slot promise-chain mutex those handlers share to run one at a time.
 */
import { describe, it, expect } from 'vitest';
import { makeWriteLock } from '../src/lib/write-lock.js';

describe('makeWriteLock', () => {
  it('serializes overlapping calls — no interleaving of critical sections', async () => {
    const withLock = makeWriteLock();
    const events: string[] = [];
    const task = (name: string) => async () => {
      events.push(`${name}:start`);
      await new Promise(r => setTimeout(r, 15));
      events.push(`${name}:end`);
    };
    // Fire both "at once"; the lock must run them strictly one after another.
    await Promise.all([withLock(task('A')), withLock(task('B'))]);
    expect(events).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
  });

  it('a rejecting critical section does not wedge the lock', async () => {
    const withLock = makeWriteLock();
    await expect(withLock(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // The next acquisition must still run.
    await expect(withLock(async () => 42)).resolves.toBe(42);
  });

  it('returns the critical section result', async () => {
    const withLock = makeWriteLock();
    await expect(withLock(async () => 'ok')).resolves.toBe('ok');
  });
});
