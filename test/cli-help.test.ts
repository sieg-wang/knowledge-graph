// test/cli-help.test.ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { join } from 'path';

// Doc-vs-code consistency guard (finding cli/index.ts:52). The `--force` flag
// used to `DELETE FROM sync` before indexing, so "(ignore sync state)" was
// accurate. Pass-3 removed that DELETE — `--force` now only bypasses the mtime
// skip and DELIBERATELY preserves the sync table so deleted-file detection
// still runs (see src/lib/index-pipeline.ts docblock + src/cli/index.ts inline
// comment). The Commander.js `--help` description is public-facing and any
// tooling may parse it, so it must not keep describing the old, removed
// behavior. This test pins the help text to the actual behavior.
const CLI = join(import.meta.dirname, '..', 'src', 'cli', 'index.ts');
const TSX = join(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx');

function indexHelp(): string {
  // Commander prints help to stdout and exits 0 for `--help`.
  return execFileSync(TSX, [CLI, 'index', '--help'], { encoding: 'utf-8' });
}

describe('kg index --help', () => {
  it('does not describe the removed "(ignore sync state)" behavior', () => {
    expect(indexHelp()).not.toContain('ignore sync state');
  });

  it('describes the current behavior: preserves sync / bypasses mtime skip', () => {
    const help = indexHelp();
    // The --force line must convey that sync/deletion detection is preserved.
    expect(help).toMatch(/--force/);
    expect(help.toLowerCase()).toMatch(/sync|deletion|mtime/);
  });
});
