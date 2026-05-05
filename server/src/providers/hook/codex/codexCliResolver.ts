import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface CodexCliResolverOptions {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  homedir?: string;
  extensionRoots?: string[];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function platformLabels(platform: NodeJS.Platform): string[] {
  if (platform === 'win32') return ['windows', 'win32'];
  if (platform === 'darwin') return ['macos', 'darwin'];
  return [platform];
}

function archLabels(arch: NodeJS.Architecture): string[] {
  if (arch === 'x64') return ['x86_64', 'x64'];
  if (arch === 'arm64') return ['arm64', 'aarch64'];
  if (arch === 'ia32') return ['x86', 'ia32'];
  return [arch];
}

function executableNames(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['codex.exe', 'codex'] : ['codex', 'codex.exe'];
}

export function getCodexCliRelativeCandidates(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string[] {
  const candidates: string[] = [];

  for (const platformLabel of platformLabels(platform)) {
    for (const archLabel of archLabels(arch)) {
      for (const executableName of executableNames(platform)) {
        candidates.push(path.join('bin', `${platformLabel}-${archLabel}`, executableName));
      }
    }
  }

  for (const platformLabel of ['windows', 'linux', 'macos', 'darwin']) {
    for (const archLabel of ['x86_64', 'x64', 'arm64', 'aarch64']) {
      for (const executableName of executableNames(platform)) {
        candidates.push(path.join('bin', `${platformLabel}-${archLabel}`, executableName));
      }
    }
  }

  for (const executableName of executableNames(platform)) {
    candidates.push(path.join('bin', executableName));
  }

  return unique(candidates);
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function sortedDirNames(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  } catch {
    return [];
  }
}

export function findCodexCliInExtension(
  extensionPath: string,
  options: CodexCliResolverOptions = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;

  for (const relativePath of getCodexCliRelativeCandidates(platform, arch)) {
    const candidate = path.join(extensionPath, relativePath);
    if (isFile(candidate)) return candidate;
  }

  const binDir = path.join(extensionPath, 'bin');
  for (const dirName of sortedDirNames(binDir)) {
    for (const executableName of executableNames(platform)) {
      const candidate = path.join(binDir, dirName, executableName);
      if (isFile(candidate)) return candidate;
    }
  }

  return undefined;
}

function isLikelyOpenAiCodexExtension(extensionPath: string): boolean {
  const name = path.basename(extensionPath).toLowerCase();
  return name.startsWith('openai.chatgpt') || name.startsWith('openai.codex');
}

function newestFirst(extensionPaths: string[]): string[] {
  return unique(extensionPaths).sort((a, b) =>
    path.basename(b).localeCompare(path.basename(a), undefined, {
      numeric: true,
      sensitivity: 'base',
    }),
  );
}

export function getDefaultCodexExtensionRoots(homedir = os.homedir()): string[] {
  return unique(
    [
      process.env.VSCODE_EXTENSIONS,
      path.join(homedir, '.vscode', 'extensions'),
      path.join(homedir, '.vscode-insiders', 'extensions'),
    ].filter((root): root is string => !!root),
  );
}

function listOpenAiExtensionPaths(extensionRoots: string[]): string[] {
  return extensionRoots.flatMap((root) =>
    sortedDirNames(root)
      .map((dirName) => path.join(root, dirName))
      .filter(isLikelyOpenAiCodexExtension),
  );
}

export function findBundledCodexCli(
  extensionPaths: string[] = [],
  options: CodexCliResolverOptions = {},
): string | undefined {
  const explicitPaths = newestFirst(extensionPaths);
  const extensionRoots = options.extensionRoots ?? getDefaultCodexExtensionRoots(options.homedir);
  const discoveredPaths = newestFirst(listOpenAiExtensionPaths(extensionRoots));

  for (const extensionPath of unique([...explicitPaths, ...discoveredPaths])) {
    const codexCli = findCodexCliInExtension(extensionPath, options);
    if (codexCli) return codexCli;
  }

  return undefined;
}
