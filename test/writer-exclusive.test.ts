/**
 * Regression (finding writer.ts:144 / B-6): createNode's duplicate guard is
 * check-then-act — existsSync(absPath) then renameSync(tmp, absPath). rename(2)
 * silently REPLACES an existing destination, so a file that appears between the
 * check and the publish (a second MCP session, the CLI, Obsidian, a sync
 * client) is clobbered with no error. Opening the destination with O_EXCL
 * makes the publish exclusive without re-resolving a mutable temp pathname.
 *
 * We drive the race by mocking existsSync to report the file absent while it is
 * actually present on disk with sentinel content.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    lstatSync: vi.fn(actual.lstatSync),
    linkSync: vi.fn(actual.linkSync),
  };
});

import {
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'fs';
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
    vi.mocked(lstatSync).mockReset();
    vi.mocked(linkSync).mockReset();
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

  it('does not touch a pre-planted former temp-path symlink', async () => {
    const victim = join(tempVault, 'victim.txt');
    const tmpPath = join(tempVault, 'Symlink Race.md.tmp.legacy');
    writeFileSync(victim, 'PRECIOUS', 'utf-8');
    symlinkSync(victim, tmpPath);

    await expect(writer.createNode({
      title: 'Symlink Race',
      frontmatter: {},
      content: 'owned node content',
    })).resolves.toBe('Symlink Race.md');

    expect(readFileSync(victim, 'utf-8')).toBe('PRECIOUS');
    expect(lstatSync(tmpPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(tempVault, 'Symlink Race.md'), 'utf-8'))
      .toContain('owned node content');
  });

  it('does not publish by re-resolving a mutable temp pathname', async () => {
    vi.mocked(linkSync).mockImplementation(() => {
      throw new Error('linkSync must not be used for createNode publish');
    });

    await expect(writer.createNode({
      title: 'Direct Exclusive Publish',
      frontmatter: {},
      content: 'written through an exclusive destination fd',
    })).resolves.toBe('Direct Exclusive Publish.md');

    expect(linkSync).not.toHaveBeenCalled();
  });

  it('never removes a destination successor that appears after publish', async () => {
    const actualFs = await vi.importActual<typeof import('fs')>('fs');
    const absPath = join(tempVault, 'Destination Successor.md');
    const successor = 'CONCURRENT-WRITER-SUCCESSOR';
    let swapped = false;

    vi.mocked(lstatSync).mockImplementation((path, options) => {
      if (!swapped && String(path) === absPath) {
        unlinkSync(absPath);
        writeFileSync(absPath, successor, 'utf-8');
        swapped = true;
      }
      return actualFs.lstatSync(path, options as never);
    });

    await expect(writer.createNode({
      title: 'Destination Successor',
      frontmatter: {},
      content: 'first writer content',
    })).rejects.toThrow(/publish path changed|node path changed/i);

    expect(swapped).toBe(true);
    expect(readFileSync(absPath, 'utf-8')).toBe(successor);
  });
});
