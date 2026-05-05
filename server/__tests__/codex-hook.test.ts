import { spawn } from 'child_process';
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const HOOK_SCRIPT = path.join(__dirname, '../../dist/hooks/codex-hook.js');
const HOOK_ENTRY = path.join(__dirname, '../src/providers/hook/codex/hooks/codex-hook.ts');

let tmpBase: string;

function writeServerJson(port: number, token: string): void {
  const dir = path.join(tmpBase, '.pixel-agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'server.json'),
    JSON.stringify({ port, pid: process.pid, token, startedAt: Date.now() }),
  );
}

function runHookScript(stdin: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [HOOK_SCRIPT], {
      env: { ...process.env, HOME: tmpBase, USERPROFILE: tmpBase },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe('codex-hook.js integration', () => {
  beforeAll(() => {
    fs.mkdirSync(path.dirname(HOOK_SCRIPT), { recursive: true });
    esbuild.buildSync({
      entryPoints: [HOOK_ENTRY],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile: HOOK_SCRIPT,
      banner: { js: '#!/usr/bin/env node' },
    });
  });

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hook-int-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('reads stdin and POSTs to server', async () => {
    const received: Array<{ url?: string; body: string }> = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push({ url: req.url, body });
        res.writeHead(200);
        res.end('ok');
      });
    });

    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    writeServerJson(port, 'test-token');

    const event = JSON.stringify({ session_id: 'abc', hook_event_name: 'Stop' });
    const { code } = await runHookScript(event);

    server.close();
    expect(code).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe('/api/hooks/codex');
    expect(JSON.parse(received[0].body).session_id).toBe('abc');
  });

  it('exits 0 when server.json is missing', async () => {
    const { code } = await runHookScript(
      JSON.stringify({ session_id: 'x', hook_event_name: 'Stop' }),
    );
    expect(code).toBe(0);
  });

  it('exits 0 on invalid stdin', async () => {
    writeServerJson(9999, 'tok');
    const { code } = await runHookScript('not json at all!!!');
    expect(code).toBe(0);
  });
});
