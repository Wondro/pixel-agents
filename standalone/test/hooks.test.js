import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  areCodexHooksInstalled,
  copyCodexHookScript,
  createHookServerConfig,
  deleteHookServerConfig,
  installCodexHooks,
  isAuthorizedHookRequest,
  uninstallCodexHooks,
  writeHookServerConfig,
} from '../src/hooks.js';

function withTempHome(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-hooks-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  return homeDir;
}

test('installs and removes standalone Codex hook entries idempotently', (t) => {
  const homeDir = withTempHome(t);

  assert.equal(areCodexHooksInstalled({ homeDir }), false);
  installCodexHooks({ homeDir });
  installCodexHooks({ homeDir });
  assert.equal(areCodexHooksInstalled({ homeDir }), true);

  const config = JSON.parse(fs.readFileSync(path.join(homeDir, '.codex', 'hooks.json'), 'utf-8'));
  assert.equal(config.hooks.SessionStart.length, 1);

  uninstallCodexHooks({ homeDir });
  assert.equal(areCodexHooksInstalled({ homeDir }), false);
});

test('copies hook relay and writes server discovery config', (t) => {
  const homeDir = withTempHome(t);
  const repoRoot = path.join(homeDir, 'repo');
  const hookSourceDir = path.join(repoRoot, 'dist', 'hooks');
  fs.mkdirSync(hookSourceDir, { recursive: true });
  fs.writeFileSync(path.join(hookSourceDir, 'codex-hook.js'), '// hook');

  const copied = copyCodexHookScript(repoRoot, { homeDir });
  assert.equal(fs.readFileSync(copied, 'utf-8'), '// hook');

  const config = createHookServerConfig(3333, 'secret-token');
  writeHookServerConfig(config, { homeDir });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(homeDir, '.pixel-agents', 'server.json'), 'utf-8')),
    config,
  );

  deleteHookServerConfig({ homeDir, pid: process.pid });
  assert.equal(fs.existsSync(path.join(homeDir, '.pixel-agents', 'server.json')), false);
});

test('validates hook bearer token with exact match only', () => {
  assert.equal(isAuthorizedHookRequest('Bearer abc', 'abc'), true);
  assert.equal(isAuthorizedHookRequest('Bearer nope', 'abc'), false);
  assert.equal(isAuthorizedHookRequest('', 'abc'), false);
});
