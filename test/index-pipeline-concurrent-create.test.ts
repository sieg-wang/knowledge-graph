/**
 * Regression (finding index-pipeline.ts:73): cross-process TOCTOU. index()
 * builds currentPaths from the parseVault SNAPSHOT but builds its deletion
 * candidate set from allNodeIds() read AFTER the parse. A node created via
 * kg_create_node in another process (a second MCP session, or MCP-vs-CLI, all
 * sharing one kg.db) during index()'s parse window therefore appears in
 * allNodeIds() but not in currentPaths, so the deletion pass destroys its DB
 * record even though the markdown file exists on disk.
 *
 * The fix narrows the blast radius: before deleting a candidate absent from the
 * parse snapshot, re-verify with existsSync — a file that exists on disk is
 * never treated as deleted regardless of parse-snapshot age. We drive the seam
 * by mocking parseVault for the second run to return a snapshot that predates
 * the concurrently-created file (which is nonetheless on disk and in the store).
 */
import { describe, it, expect, vi } from 'vitest';
import { join } from 'path';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

// Default the mock to the REAL parseVault; the second run overrides once.
vi.mock('../src/lib/parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/parser.js')>();
  return { ...actual, parseVault: vi.fn(actual.parseVault) };
});

import { Store } from '../src/lib/store.js';
import { Embedder } from '../src/lib/embedder.js';
import { IndexPipeline } from '../src/lib/index-pipeline.js';
import { VaultWriter } from '../src/lib/writer.js';
import { parseVault } from '../src/lib/parser.js';

// Stub embedder — the pipeline only calls embed(); avoids loading the model.
const stubEmbedder = { embed: async () => new Float32Array(384) } as unknown as Embedder;

describe('IndexPipeline concurrent-create TOCTOU (deletion vs on-disk file)', () => {
  it('does not delete a node whose file exists on disk but is absent from the parse snapshot', async () => {
    const store = new Store(':memory:');
    const pipeline = new IndexPipeline(store, stubEmbedder);
    const vault = mkdtempSync(join(tmpdir(), 'kg-concurrent-create-'));
    const writer = new VaultWriter(vault, store);
    try {
      // Run 1 (real parseVault): index a one-note vault → Root.md + sync row.
      writeFileSync(join(vault, 'Root.md'), '# Root\n\nroot body.\n');
      await pipeline.index(vault);
      expect(store.getNode('Root.md')).toBeDefined();

      // A concurrent process (kg_create_node) publishes Notes/New.md: the file
      // lands on disk and the node is upserted, with NO sync row (createNode's
      // path). This is exactly what a second MCP session does.
      await writer.createNode({
        title: 'New',
        directory: 'Notes',
        frontmatter: {},
        content: 'freshly created concurrently.',
      });
      expect(store.getNode('Notes/New.md')).toBeDefined();

      // Run 2: process 1's parse window fixed its snapshot BEFORE New.md
      // appeared, so parseVault returns only Root.md. New.md is in allNodeIds()
      // (read after the parse) but not in currentPaths.
      vi.mocked(parseVault).mockImplementationOnce(async () => ({
        nodes: [{
          id: 'Root.md',
          title: 'Root',
          content: '# Root\n\nroot body.\n',
          frontmatter: {},
          mtimeMs: Date.now(),
        }],
        edges: [],
        stubIds: new Set<string>(),
      }));

      await pipeline.index(vault);

      // BUGGY: New.md was deleteNode()'d despite existing on disk.
      // FIXED: the existsSync re-check keeps the record.
      expect(store.getNode('Notes/New.md')).toBeDefined();
    } finally {
      store.close();
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
