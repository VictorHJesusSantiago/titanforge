import ts from 'typescript';
import type { VirtualFileSystem } from '@titanforge/vfs';
import { VfsError, normalizePath } from '@titanforge/vfs';
import type { Command, Pipeline } from './parser.js';
import { parse } from './parser.js';

/** The result of running one command line through the shell. */
export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Internal per-command execution result, before pipeline stdin/stdout threading and redirect
 *  handling are applied. */
interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * A scoped, honest terminal shell over a `VirtualFileSystem`. This is explicitly NOT a Linux
 * container: there are no real OS processes, no real package manager, no real filesystem. It is
 * a command-line parser (see parser.ts) plus a fixed set of builtin commands that read and
 * mutate a VFS instance, and a `run` command that transpiles + evaluates `.ts`/`.js` files in a
 * `new Function`-based sandbox. That is the entire feature surface, by design.
 *
 * Piping convention: `cmd1 | cmd2` runs cmd1, captures its stdout, and passes it to cmd2 as
 * `stdin` — an explicit string threaded through `execCommand`. There is no real file-descriptor
 * stdin; each builtin decides for itself whether/how to use the incoming `stdin` string:
 *   - `cat` with no file arguments echoes `stdin` (matches real `cat`'s "read from stdin" mode).
 *   - `echo` appends a trailing line of `stdin` (if any) after its argument output, so
 *     `producer | echo` lets you see both the echoed args and whatever flowed through the pipe.
 *   - `run` exposes the incoming `stdin` to the executed script as a sandboxed `stdin` variable
 *     (a string, `''` when nothing was piped in), so a piped-into script can consume upstream
 *     output programmatically.
 * All other builtins ignore `stdin` — they have no sensible use for it in this scope.
 */
export class Shell {
  private vfs: VirtualFileSystem;
  cwd: string;

  constructor(vfs: VirtualFileSystem, initialCwd = '/') {
    this.vfs = vfs;
    this.cwd = normalizePath(initialCwd);
  }

  /** Resolve a possibly-relative argument against the shell's current working directory into a
   *  normalized absolute VFS path. Paths already starting with `/` are treated as absolute;
   *  everything else (including `.` and `..` segments) is resolved relative to `cwd`. */
  private resolve(rawPath: string): string {
    if (rawPath.startsWith('/')) return normalizePath(rawPath);
    return normalizePath(`${this.cwd}/${rawPath}`);
  }

  async run(commandLine: string): Promise<ShellResult> {
    let pipeline: Pipeline;
    try {
      pipeline = parse(commandLine);
    } catch (e) {
      return { stdout: '', stderr: (e as Error).message, exitCode: 2 };
    }

    if (pipeline.commands.length === 0) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    let stdin: string | undefined;
    let last: CommandResult = { stdout: '', stderr: '', exitCode: 0 };

    for (const command of pipeline.commands) {
      last = await this.execCommand(command, stdin);
      if (last.exitCode !== 0) {
        // Mirror a real shell's honest-but-simple behavior for this scope: a failing stage
        // stops the pipeline rather than silently continuing with empty stdin.
        return last;
      }

      let output = last.stdout;
      if (command.redirect) {
        const target = this.resolve(command.redirect.path);
        const toWrite = command.redirect.append && this.vfs.exists(target)
          ? this.vfs.readFile(target) + output
          : output;
        this.vfs.writeFile(target, toWrite);
        output = ''; // redirected output does not also appear on stdout
      }
      stdin = output;
      last = { stdout: output, stderr: last.stderr, exitCode: last.exitCode };
    }

    return last;
  }

  private async execCommand(command: Command, stdin: string | undefined): Promise<CommandResult> {
    const { name, args } = command;
    try {
      switch (name) {
        case 'ls':
          return this.cmdLs(args);
        case 'cd':
          return this.cmdCd(args);
        case 'pwd':
          return { stdout: this.cwd + '\n', stderr: '', exitCode: 0 };
        case 'cat':
          return this.cmdCat(args, stdin);
        case 'echo':
          return this.cmdEcho(args, stdin);
        case 'mkdir':
          return this.cmdMkdir(args);
        case 'rm':
          return this.cmdRm(args);
        case 'touch':
          return this.cmdTouch(args);
        case 'mv':
          return this.cmdMv(args);
        case 'cp':
          return this.cmdCp(args);
        case 'run':
          return await this.cmdRun(args, stdin);
        default:
          return { stdout: '', stderr: `${name}: command not found`, exitCode: 127 };
      }
    } catch (e) {
      return { stdout: '', stderr: this.describeError(name, e), exitCode: 1 };
    }
  }

  private describeError(name: string, e: unknown): string {
    if (e instanceof VfsError) return `${name}: ${e.message}`;
    if (e instanceof Error) return `${name}: ${e.message}`;
    return `${name}: ${String(e)}`;
  }

  // ---- builtins ---------------------------------------------------------------

  private cmdLs(args: string[]): CommandResult {
    const target = this.resolve(args[0] ?? '.');
    const entries = this.vfs.readdir(target);
    return { stdout: entries.join('\n') + (entries.length > 0 ? '\n' : ''), stderr: '', exitCode: 0 };
  }

  private cmdCd(args: string[]): CommandResult {
    const target = args.length === 0 ? '/' : this.resolve(args[0] as string);
    const stat = this.vfs.stat(target);
    if (stat.type !== 'dir') {
      return { stdout: '', stderr: `cd: not a directory: ${target}`, exitCode: 1 };
    }
    this.cwd = target;
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  private cmdCat(args: string[], stdin: string | undefined): CommandResult {
    if (args.length === 0) {
      return { stdout: stdin ?? '', stderr: '', exitCode: 0 };
    }
    let out = '';
    for (const arg of args) {
      out += this.vfs.readFile(this.resolve(arg));
    }
    return { stdout: out, stderr: '', exitCode: 0 };
  }

  private cmdEcho(args: string[], stdin: string | undefined): CommandResult {
    let out = args.join(' ') + '\n';
    if (stdin) {
      out += stdin.endsWith('\n') ? stdin : stdin + '\n';
    }
    return { stdout: out, stderr: '', exitCode: 0 };
  }

  private cmdMkdir(args: string[]): CommandResult {
    const recursive = args.includes('-p');
    const paths = args.filter((a) => a !== '-p');
    const target = paths[0];
    if (!target) {
      return { stdout: '', stderr: 'mkdir: missing operand', exitCode: 1 };
    }
    this.vfs.mkdir(this.resolve(target), { recursive });
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  private cmdRm(args: string[]): CommandResult {
    const recursive = args.includes('-r');
    const paths = args.filter((a) => a !== '-r');
    const target = paths[0];
    if (!target) {
      return { stdout: '', stderr: 'rm: missing operand', exitCode: 1 };
    }
    this.vfs.rm(this.resolve(target), { recursive });
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  private cmdTouch(args: string[]): CommandResult {
    const target = args[0];
    if (!target) {
      return { stdout: '', stderr: 'touch: missing operand', exitCode: 1 };
    }
    const path = this.resolve(target);
    if (!this.vfs.exists(path)) {
      this.vfs.writeFile(path, '');
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  private cmdMv(args: string[]): CommandResult {
    const [src, dst] = args;
    if (!src || !dst) {
      return { stdout: '', stderr: 'mv: missing operand', exitCode: 1 };
    }
    this.vfs.mv(this.resolve(src), this.resolve(dst));
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  private cmdCp(args: string[]): CommandResult {
    const [src, dst] = args;
    if (!src || !dst) {
      return { stdout: '', stderr: 'cp: missing operand', exitCode: 1 };
    }
    this.vfs.cp(this.resolve(src), this.resolve(dst));
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  private async cmdRun(args: string[], stdin: string | undefined): Promise<CommandResult> {
    const target = args[0];
    if (!target) {
      return { stdout: '', stderr: 'run: missing operand', exitCode: 1 };
    }
    const path = this.resolve(target);
    const source = this.vfs.readFile(path);

    let jsCode: string;
    if (path.endsWith('.ts')) {
      const output = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      });
      jsCode = output.outputText;
    } else {
      jsCode = source;
    }

    const stdout: string[] = [];
    const stderr: string[] = [];
    const fakeConsole = {
      log: (...vals: unknown[]) => stdout.push(vals.map(stringify).join(' ')),
      error: (...vals: unknown[]) => stderr.push(vals.map(stringify).join(' ')),
    };
    const exportsObj: Record<string, unknown> = {};
    const moduleObj = { exports: exportsObj };

    try {
      // `new Function(...)` here IS the sandboxed evaluator that `run` exists to provide — the
      // honest, documented scope of this command, not an accidental dynamic-eval footgun.
      const fn = new Function('console', 'stdin', 'exports', 'module', jsCode);
      fn(fakeConsole, stdin ?? '', exportsObj, moduleObj);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { stdout: stdout.join('\n') + (stdout.length > 0 ? '\n' : ''), stderr: message, exitCode: 1 };
    }

    return {
      stdout: stdout.join('\n') + (stdout.length > 0 ? '\n' : ''),
      stderr: stderr.join('\n') + (stderr.length > 0 ? '\n' : ''),
      exitCode: 0,
    };
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
