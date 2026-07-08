/**
 * parseVault must tolerate weird / vanishing directory entries instead of
 * aborting the whole index run (or leaking out-of-vault content):
 *
 *  - A regular *.md file deleted between readdir() and readFile() → skip,
 *    don't throw (finding parser.ts:29, was "MAJOR-4" on the stat window).
 *  - A dangling *.md symlink → skip, don't abort (finding parser.ts:162 / :29).
 *  - A *.md symlink whose target is OUTSIDE the vault → exclude its content,
 *    never index a secret file's bytes (finding parser.ts:162, B-5).
 *  - A symlink to a DIRECTORY named *.md → no EISDIR abort (finding B-5).
 *
 * The regular-file race is injected with a readFile mock; the symlink cases use
 * real symlinks so they exercise collectMarkdownFiles' dirent handling.
 */
import { describe, it, expect, vi } from 'vitest';
import { join } from 'path';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from 'fs';
import { tmpdir } from 'os';

// readFileMockTarget: when set to a path suffix, the next readFile matching it
// throws ENOENT once (simulating a delete between readdir and readFile), then
// resets. All other calls pass through to the real implementation.
let readFileMockTarget: string | null = null;

vi.mock('fs/promises', async (importOriginal) => {
  const mod = await importOriginal<typeof import('fs/promises')>();
  return {
    ...mod,
    readFile: vi.fn(async (p: unknown, ...rest: unknown[]) => {
      if (readFileMockTarget && String(p).endsWith(readFileMockTarget)) {
        readFileMockTarget = null;
        throw Object.assign(
          new Error(`ENOENT: no such file or directory, open '${p}'`),
          { code: 'ENOENT' },
        );
      }
      return mod.readFile(p as never, ...(rest as never[]));
    }),
  };
});

// Imports come AFTER vi.mock so the mock is active.
import { Store } from '../src/lib/store.js';
import { Embedder } from '../src/lib/embedder.js';
import { IndexPipeline } from '../src/lib/index-pipeline.js';
import { parseVault } from '../src/lib/parser.js';

const stubEmbedder = { embed: async () => new Float32Array(384) } as unknown as Embedder;

describe('parseVault: vanishing / non-regular entries', () => {
  it('skips a regular file that disappears between readdir and readFile, keeps survivors', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-enoent-'));
    try {
      writeFileSync(join(tmpVault, 'Alive.md'), '# Alive\nsurvives\n', 'utf-8');
      writeFileSync(join(tmpVault, 'Gone.md'), '# Gone\ndisappears\n', 'utf-8');

      readFileMockTarget = 'Gone.md';
      const { nodes } = await parseVault(tmpVault);
      const ids = nodes.map(n => n.id);

      expect(ids).toContain('Alive.md');
      expect(ids).not.toContain('Gone.md');
    } finally {
      readFileMockTarget = null;
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  it('skips a dangling *.md symlink without aborting the parse', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-dangling-'));
    try {
      writeFileSync(join(tmpVault, 'real.md'), '# Real\ncontent\n', 'utf-8');
      // Points at a target that does not exist → readFile would ENOENT.
      symlinkSync('./missing-target.md', join(tmpVault, 'ghost.md'));

      const { nodes } = await parseVault(tmpVault);
      const ids = nodes.map(n => n.id);
      expect(ids).toContain('real.md');
      expect(ids).not.toContain('ghost.md');
    } finally {
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  it('does not index the content of a *.md symlink pointing outside the vault', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-leak-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'kg-outside-'));
    const sentinel = 'TOP-SECRET-PRIVATE-KEY-SENTINEL';
    try {
      writeFileSync(join(outsideDir, 'secret.txt'), `${sentinel}\n`, 'utf-8');
      writeFileSync(join(tmpVault, 'real.md'), '# Real\ncontent\n', 'utf-8');
      symlinkSync(join(outsideDir, 'secret.txt'), join(tmpVault, 'leak.md'));

      const { nodes } = await parseVault(tmpVault);
      // The out-of-vault secret must never enter the parsed corpus.
      expect(nodes.some(n => n.content.includes(sentinel))).toBe(false);
      expect(nodes.map(n => n.id)).not.toContain('leak.md');
    } finally {
      rmSync(tmpVault, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('does not abort on a symlink to a directory named *.md (EISDIR)', async () => {
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-dirlink-'));
    const someDir = mkdtempSync(join(tmpdir(), 'kg-somedir-'));
    try {
      writeFileSync(join(tmpVault, 'real.md'), '# Real\ncontent\n', 'utf-8');
      symlinkSync(someDir, join(tmpVault, 'dir.md'));

      const { nodes } = await parseVault(tmpVault);
      const ids = nodes.map(n => n.id);
      expect(ids).toContain('real.md');
      expect(ids).not.toContain('dir.md');
    } finally {
      rmSync(tmpVault, { recursive: true, force: true });
      rmSync(someDir, { recursive: true, force: true });
    }
  });

  it('pipeline.index completes when a file vanishes mid-parse (survivors indexed)', async () => {
    const store = new Store(':memory:');
    const pipeline = new IndexPipeline(store, stubEmbedder);
    const tmpVault = mkdtempSync(join(tmpdir(), 'kg-enoent-pipe-'));
    try {
      writeFileSync(join(tmpVault, 'Alive.md'), '# Alive\nsurvives\n', 'utf-8');
      writeFileSync(join(tmpVault, 'Gone.md'), '# Gone\ndisappears\n', 'utf-8');

      readFileMockTarget = 'Gone.md';
      await expect(pipeline.index(tmpVault)).resolves.toBeDefined();

      expect(store.getNode('Alive.md')).toBeDefined();
      expect(store.getNode('Gone.md')).toBeUndefined();
    } finally {
      readFileMockTarget = null;
      store.close();
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });
});
