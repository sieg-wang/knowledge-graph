/**
 * Regression (finding writer.ts:144 / B-6): createNode's duplicate guard is
 * check-then-act — existsSync(absPath) then renameSync(tmp, absPath). rename(2)
 * silently REPLACES an existing destination, so a file that appears between the
 * check and the publish (a second MCP session, the CLI, Obsidian, a sync
 * client) is clobbered with no error. Publishing with linkSync (fails EEXIST if
 * the destination exists) keeps the publish atomic AND exclusive.
 *
 * We drive the race by mocking existsSync to report the file absent while it is
 * actually present on disk with sentinel content.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { VaultWriter } from '../src/lib/writer.js';
import { Store } from '../src/lib/store.js';

describe('VaultWriter.createNode exclusive publish', () => {
  let tempVault: string;
  let store: Store;
  let writer: VaultWriter;

  beforeEach(() => {
    tempVault = mkdtempSync(join(tmpdir(), 'kg-excl-'));
    store = new Store(':memory:');
    writer = new VaultWriter(tempVault, store);
  });

  afterEach(() => {
    vi.mocked(existsSync).mockReset();
    store.close();
    rmSync(tempVault, { recursive: true, force: true });
  });

  it('does not clobber a file that appeared after the existsSync check', async () => {
    const sentinel = 'PRE-EXISTING-CONTENT-SENTINEL';
    const absPath = join(tempVault, 'Racey.md');
    // A concurrent writer has already materialized the same-named note.
    writeFileSync(absPath, sentinel, 'utf-8');

    // Force the check-then-act guard to believe the destination is free.
    vi.mocked(existsSync).mockReturnValue(false);

    await expect(writer.createNode({
      title: 'Racey',
      frontmatter: {},
      content: 'new content that must NOT overwrite',
    })).rejects.toThrow(/already exists|EEXIST/i);

    // The other writer's content must survive — rename would have clobbered it.
    expect(readFileSync(absPath, 'utf-8')).toContain(sentinel);
  });
});
