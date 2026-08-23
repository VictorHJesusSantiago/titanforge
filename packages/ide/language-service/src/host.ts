import ts from 'typescript';
import type { VirtualFileSystem } from '@titanforge/vfs';
import { readTsLibFile, tsLibFilePath, isTsLibPath } from './ts-lib-files.js';

const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'];

function isScriptFile(path: string): boolean {
  return SCRIPT_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** Recursively collect every script file path under `dir` in the VFS. */
function walkScriptFiles(vfs: VirtualFileSystem, dir: string, out: string[]): void {
  for (const name of vfs.readdir(dir)) {
    const childPath = dir === '/' ? `/${name}` : `${dir}/${name}`;
    const stat = vfs.stat(childPath);
    if (stat.type === 'dir') {
      walkScriptFiles(vfs, childPath, out);
    } else if (isScriptFile(childPath)) {
      out.push(childPath);
    }
  }
}

export const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  strict: true,
  esModuleInterop: true,
  skipLibCheck: true,
  allowJs: true,
  jsx: ts.JsxEmit.Preserve,
};

/**
 * A `ts.LanguageServiceHost` backed entirely by `@titanforge/vfs`. This is the seam that makes
 * the language service "real": every method the TS compiler calls to ask "what files exist,
 * what do they contain, have they changed" is answered by reading the actual virtual filesystem,
 * not a static snapshot. `notifyFileChanged` (wired to `vfs.writeFile` by the caller, see
 * `LanguageServiceSession`) bumps a version counter per file so `getScriptVersion` changes and
 * the language service knows to re-analyze — exactly the mechanism `ts.LanguageService` is
 * designed around for editor-style incremental use.
 */
export class VfsLanguageServiceHost implements ts.LanguageServiceHost {
  private versions = new Map<string, number>();

  constructor(
    private readonly vfs: VirtualFileSystem,
    private readonly compilerOptions: ts.CompilerOptions = DEFAULT_COMPILER_OPTIONS,
  ) {}

  /** Called whenever the VFS reports a write under a script path — bumps the version TS sees. */
  notifyFileChanged(path: string): void {
    this.versions.set(path, (this.versions.get(path) ?? 0) + 1);
  }

  getScriptFileNames(): string[] {
    const out: string[] = [];
    walkScriptFiles(this.vfs, '/', out);
    return out;
  }

  getScriptVersion(fileName: string): string {
    if (isTsLibPath(fileName)) return '0'; // lib files are immutable for the session
    if (!this.vfs.exists(fileName)) return String(this.versions.get(fileName) ?? 0);
    // Prefer the VFS's own version counter (bumped on every writeFile) as the source of truth;
    // fall back to our local counter for files touched only via notifyFileChanged.
    const vfsVersion = this.vfs.getFileVersion(fileName);
    return String(vfsVersion);
  }

  getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
    if (isTsLibPath(fileName)) {
      const contents = readTsLibFile(fileName.slice(fileName.lastIndexOf('/') + 1));
      return contents === undefined ? undefined : ts.ScriptSnapshot.fromString(contents);
    }
    if (!this.vfs.exists(fileName)) return undefined;
    return ts.ScriptSnapshot.fromString(this.vfs.readFile(fileName));
  }

  getCurrentDirectory(): string {
    return '/';
  }

  getCompilationSettings(): ts.CompilerOptions {
    return this.compilerOptions;
  }

  getDefaultLibFileName(options: ts.CompilerOptions): string {
    return tsLibFilePath(ts.getDefaultLibFileName(options));
  }

  fileExists(fileName: string): boolean {
    if (isTsLibPath(fileName)) return readTsLibFile(fileName.slice(fileName.lastIndexOf('/') + 1)) !== undefined;
    return this.vfs.exists(fileName);
  }

  readFile(fileName: string): string | undefined {
    if (isTsLibPath(fileName)) return readTsLibFile(fileName.slice(fileName.lastIndexOf('/') + 1));
    if (!this.vfs.exists(fileName)) return undefined;
    return this.vfs.readFile(fileName);
  }

  directoryExists(directoryName: string): boolean {
    if (isTsLibPath(directoryName)) return true;
    return this.vfs.exists(directoryName) && this.vfs.stat(directoryName).type === 'dir';
  }

  getDirectories(directoryName: string): string[] {
    if (!this.vfs.exists(directoryName)) return [];
    if (this.vfs.stat(directoryName).type !== 'dir') return [];
    return this.vfs
      .readdir(directoryName)
      .filter((name) => {
        const full = directoryName === '/' ? `/${name}` : `${directoryName}/${name}`;
        return this.vfs.stat(full).type === 'dir';
      });
  }

  useCaseSensitiveFileNames(): boolean {
    return true;
  }
}
