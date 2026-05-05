import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { areHooksInstalled, installHooks, uninstallHooks, copyHookScript } =
  await import('../src/providers/hook/codex/codexHookInstaller.js');
const { CODEX_HOOK_EVENTS } = await import('../src/providers/hook/codex/constants.js');

function readHooksConfig(): Record<string, unknown> {
  const p = path.join(tmpBase, '.codex', 'hooks.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
}

describe('codexHookInstaller', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hook-test-'));
    fs.mkdirSync(path.join(tmpBase, '.codex'), { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('installHooks adds entries to hooks.json', () => {
    installHooks();
    const hooks = readHooksConfig().hooks as Record<string, unknown[]>;
    for (const event of CODEX_HOOK_EVENTS) {
      expect(hooks[event]).toHaveLength(1);
    }
  });

  it('installHooks is idempotent', () => {
    installHooks();
    installHooks();
    const hooks = readHooksConfig().hooks as Record<string, unknown[]>;
    expect(hooks['SessionStart']).toHaveLength(1);
  });

  it('areHooksInstalled returns true after install', () => {
    installHooks();
    expect(areHooksInstalled()).toBe(true);
  });

  it('uninstallHooks removes entries', () => {
    installHooks();
    uninstallHooks();
    expect(areHooksInstalled()).toBe(false);
  });

  it('handles missing hooks.json gracefully', () => {
    expect(() => areHooksInstalled()).not.toThrow();
    expect(areHooksInstalled()).toBe(false);
  });

  it('copyHookScript copies to ~/.pixel-agents/hooks/', () => {
    const mockExtPath = path.join(tmpBase, 'mock-ext');
    const hookSrc = path.join(mockExtPath, 'dist', 'hooks');
    fs.mkdirSync(hookSrc, { recursive: true });
    fs.writeFileSync(path.join(hookSrc, 'codex-hook.js'), '// mock hook script');

    copyHookScript(mockExtPath);

    const dst = path.join(tmpBase, '.pixel-agents', 'hooks', 'codex-hook.js');
    expect(fs.existsSync(dst)).toBe(true);
    expect(fs.readFileSync(dst, 'utf-8')).toBe('// mock hook script');
  });
});
