import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  findBundledCodexCli,
  findCodexCliInExtension,
} from '../src/providers/hook/codex/codexCliResolver.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-codex-cli-'));
  tempDirs.push(tempDir);
  return tempDir;
}

function touch(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '');
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('codex CLI resolver', () => {
  it('finds the bundled Windows x64 Codex executable in a VS Code extension path', () => {
    const extensionPath = path.join(makeTempDir(), 'openai.chatgpt-26.429.30905-win32-x64');
    const executablePath = path.join(extensionPath, 'bin', 'windows-x86_64', 'codex.exe');
    touch(executablePath);

    expect(
      findBundledCodexCli([extensionPath], {
        platform: 'win32',
        arch: 'x64',
        extensionRoots: [],
      }),
    ).toBe(executablePath);
  });

  it('prefers the newest OpenAI extension folder discovered from extension roots', () => {
    const extensionRoot = makeTempDir();
    const oldExecutable = path.join(
      extensionRoot,
      'openai.chatgpt-26.422.71525-win32-x64',
      'bin',
      'windows-x86_64',
      'codex.exe',
    );
    const newExecutable = path.join(
      extensionRoot,
      'openai.chatgpt-26.429.30905-win32-x64',
      'bin',
      'windows-x86_64',
      'codex.exe',
    );
    touch(oldExecutable);
    touch(newExecutable);

    expect(
      findBundledCodexCli([], {
        platform: 'win32',
        arch: 'x64',
        extensionRoots: [extensionRoot],
      }),
    ).toBe(newExecutable);
  });

  it('falls back to a shallow bin search when the platform directory is unknown', () => {
    const extensionPath = path.join(makeTempDir(), 'openai.codex-dev');
    const executablePath = path.join(extensionPath, 'bin', 'custom-platform', 'codex.exe');
    touch(executablePath);

    expect(
      findCodexCliInExtension(extensionPath, {
        platform: 'win32',
        arch: 'x64',
        extensionRoots: [],
      }),
    ).toBe(executablePath);
  });
});
