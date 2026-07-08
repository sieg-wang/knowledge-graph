/**
 * Regression (finding mcp/index.ts:327): main().catch(console.error) logged and
 * SWALLOWED any post-config startup failure — new Store() throwing (corrupt
 * kg.db, dataDir/kg.db existing as a directory) or server.connect() rejecting —
 * after which the event loop drained and the process exited 0. An MCP client
 * then saw a clean exit instead of a startup failure. The handler must write a
 * startup-error message to stderr and exit non-zero.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('MCP entrypoint startup failure', () => {
  it('exits non-zero and reports a startup error when kg.db is unusable', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'kg-mcp-startup-'));
    const vault = mkdtempSync(join(tmpdir(), 'kg-mcp-vault-'));
    // Make kg.db a DIRECTORY so `new Store(dbPath)` throws at startup.
    mkdirSync(join(dataDir, 'kg.db'));
    const entry = join(process.cwd(), 'src', 'mcp', 'index.ts');
    try {
      const child = spawn('npx', ['tsx', entry], {
        env: { ...process.env, KG_VAULT_PATH: vault, KG_DATA_DIR: dataDir },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += String(d); });
      const code: number = await new Promise((resolve) => {
        child.on('exit', (c) => resolve(c ?? -1));
      });

      expect(code).not.toBe(0);
      expect(stderr).toMatch(/startup error/i);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(vault, { recursive: true, force: true });
    }
  }, 60000);
});
