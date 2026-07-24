import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VaultWriter } from '../src/lib/writer.js';
import { Store } from '../src/lib/store.js';

describe('VaultWriter append path identity', () => {
  let tempVault: string;
  let source: string;
  let victim: string;
  let store: Store;
  let writer: VaultWriter;

  beforeEach(() => {
    tempVault = mkdtempSync(join(tmpdir(), 'kg-append-race-'));
    source = join(tempVault, 'Source.md');
    victim = join(tempVault, 'outside-victim.txt');
    writeFileSync(source, '---\ntitle: Source\n---\nOriginal.\n', 'utf-8');
    writeFileSync(victim, 'PRECIOUS', 'utf-8');
    store = new Store(':memory:');
    writer = new VaultWriter(tempVault, store);
  });

  afterEach(() => {
    vi.mocked(existsSync).mockReset();
    store.close();
    rmSync(tempVault, { recursive: true, force: true });
  });

  function swapSourceToSymlinkDuringExistenceCheck(): void {
    let swapped = false;
    vi.mocked(existsSync).mockImplementation((path) => {
      if (!swapped && String(path) === source) {
        unlinkSync(source);
        symlinkSync(victim, source);
        swapped = true;
      }
      return true;
    });
  }

  it('annotateNode rejects a file-to-symlink swap without touching the target', async () => {
    swapSourceToSymlinkDuringExistenceCheck();

    await expect(writer.annotateNode('Source.md', '\nPWNED')).rejects.toThrow();

    expect(readFileSync(victim, 'utf-8')).toBe('PRECIOUS');
  });

  it('addLink rejects a file-to-symlink swap without touching the target', async () => {
    swapSourceToSymlinkDuringExistenceCheck();

    await expect(writer.addLink('Source.md', 'Target', 'context')).rejects.toThrow();

    expect(readFileSync(victim, 'utf-8')).toBe('PRECIOUS');
  });
});
