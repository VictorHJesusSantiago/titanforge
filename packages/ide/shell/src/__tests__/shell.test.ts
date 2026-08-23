import { describe, it, expect } from 'vitest';
import { VirtualFileSystem } from '@titanforge/vfs';
import { Shell } from '../shell.js';

describe('Shell: navigation and basic commands', () => {
  it('pwd reflects the initial cwd', async () => {
    const shell = new Shell(new VirtualFileSystem());
    const result = await shell.run('pwd');
    expect(result.stdout).toBe('/\n');
    expect(result.exitCode).toBe(0);
  });

  it('mkdir then cd then touch mutates the real vfs', async () => {
    const vfs = new VirtualFileSystem();
    const shell = new Shell(vfs);
    expect((await shell.run('mkdir foo')).exitCode).toBe(0);
    expect((await shell.run('cd foo')).exitCode).toBe(0);
    expect((await shell.run('touch bar.txt')).exitCode).toBe(0);
    expect(vfs.exists('/foo/bar.txt')).toBe(true);
    expect(vfs.readFile('/foo/bar.txt')).toBe('');
  });

  it('touch does not truncate an existing file', async () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/a.txt', 'keep me');
    const shell = new Shell(vfs);
    await shell.run('touch a.txt');
    expect(vfs.readFile('/a.txt')).toBe('keep me');
  });

  it('cd with no args returns to root', async () => {
    const vfs = new VirtualFileSystem();
    vfs.mkdir('/a/b', { recursive: true });
    const shell = new Shell(vfs, '/a/b');
    await shell.run('cd');
    expect((await shell.run('pwd')).stdout).toBe('/\n');
  });

  it('cd into a missing directory errors with nonzero exit', async () => {
    const shell = new Shell(new VirtualFileSystem());
    const result = await shell.run('cd /nope');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('nope');
  });

  it('cd into a file errors with nonzero exit', async () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/a.txt', 'x');
    const shell = new Shell(vfs);
    const result = await shell.run('cd a.txt');
    expect(result.exitCode).not.toBe(0);
  });

  it('cd resolves relative paths against cwd, and .. returns to the start', async () => {
    const vfs = new VirtualFileSystem();
    vfs.mkdir('/a/b', { recursive: true });
    const shell = new Shell(vfs, '/a');
    await shell.run('cd b');
    expect((await shell.run('pwd')).stdout).toBe('/a/b\n');
    await shell.run('cd ..');
    expect((await shell.run('pwd')).stdout).toBe('/a\n');
  });

  it('ls lists directory contents sorted', async () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/b.txt', '');
    vfs.writeFile('/a.txt', '');
    const shell = new Shell(vfs);
    const result = await shell.run('ls');
    expect(result.stdout).toBe('a.txt\nb.txt\n');
  });

  it('ls accepts an explicit path', async () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/dir/x.txt', '');
    const shell = new Shell(vfs);
    const result = await shell.run('ls dir');
    expect(result.stdout).toBe('x.txt\n');
  });
});

describe('Shell: cat/echo', () => {
  it('cat prints file contents', async () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/a.txt', 'hello');
    const shell = new Shell(vfs);
    const result = await shell.run('cat a.txt');
    expect(result.stdout).toBe('hello');
    expect(result.exitCode).toBe(0);
  });

  it('cat concatenates multiple files', async () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/a.txt', 'AAA');
    vfs.writeFile('/b.txt', 'BBB');
    const shell = new Shell(vfs);
    const result = await shell.run('cat a.txt b.txt');
    expect(result.stdout).toBe('AAABBB');
  });

  it('cat on a missing file returns nonzero exit and stderr', async () => {
    const shell = new Shell(new VirtualFileSystem());
    const result = await shell.run('cat missing.txt');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('echo prints space-joined args', async () => {
    const shell = new Shell(new VirtualFileSystem());
    const result = await shell.run('echo hello world');
    expect(result.stdout).toBe('hello world\n');
  });

  it('echo preserves a quoted argument as one word', async () => {
    const shell = new Shell(new VirtualFileSystem());
    const result = await shell.run('echo "hello world"');
    expect(result.stdout).toBe('hello world\n');
  });
});

describe('Shell: mkdir/rm/mv/cp', () => {
  it('mkdir -p creates nested directories', async () => {
    const vfs = new VirtualFileSystem();
    const shell = new Shell(vfs);
    await shell.run('mkdir -p /a/b/c');
    expect(vfs.exists('/a/b/c')).toBe(true);
  });

  it('rm -r removes a directory recursively', async () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/a/b/c.txt', 'x');
    const shell = new Shell(vfs);
    const result = await shell.run('rm -r /a');
    expect(result.exitCode).toBe(0);
    expect(vfs.exists('/a')).toBe(false);
  });

  it('rm without -r fails on a non-empty directory', async () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/a/b.txt', 'x');
    const shell = new Shell(vfs);
    const result = await shell.run('rm /a');
    expect(result.exitCode).not.toBe(0);
    expect(vfs.exists('/a')).toBe(true);
  });

  it('mv moves a file', async () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/a.txt', 'content');
    const shell = new Shell(vfs);
    await shell.run('mv a.txt b.txt');
    expect(vfs.exists('/a.txt')).toBe(false);
    expect(vfs.readFile('/b.txt')).toBe('content');
  });

  it('cp copies a file, leaving the source intact', async () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/a.txt', 'content');
    const shell = new Shell(vfs);
    await shell.run('cp a.txt b.txt');
    expect(vfs.readFile('/a.txt')).toBe('content');
    expect(vfs.readFile('/b.txt')).toBe('content');
  });
});

describe('Shell: unknown commands', () => {
  it('reports command not found for unknown names', async () => {
    const shell = new Shell(new VirtualFileSystem());
    const result = await shell.run('frobnicate');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe('frobnicate: command not found');
  });
});

describe('Shell: run', () => {
  it('runs a .js file and captures console.log output in order', async () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/script.js', "console.log('one'); console.log('two'); console.log('three');");
    const shell = new Shell(vfs);
    const result = await shell.run('run script.js');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('one\ntwo\nthree\n');
  });

  it('transpiles and runs a .ts file with real type annotations', async () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile(
      '/typed.ts',
      `
      function add(a: number, b: number): number {
        return a + b;
      }
      const result: number = add(2, 3);
      console.log(result);
      `,
    );
    const shell = new Shell(vfs);
    const result = await shell.run('run typed.ts');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('5\n');
  });

  it('reports a thrown error as nonzero exit with stderr message', async () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/boom.js', "throw new Error('boom');");
    const shell = new Shell(vfs);
    const result = await shell.run('run boom.js');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('boom');
  });

  it('reports a runtime error (calling an undefined function) as nonzero exit', async () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/typo.js', 'thisFunctionDoesNotExist();');
    const shell = new Shell(vfs);
    const result = await shell.run('run typo.js');
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('does not crash the shell after a failing script; subsequent commands still work', async () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/boom.js', "throw new Error('boom');");
    const shell = new Shell(vfs);
    await shell.run('run boom.js');
    const result = await shell.run('echo still alive');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('still alive\n');
  });
});

describe('Shell: pipes', () => {
  it('pipes echo output into cat', async () => {
    const shell = new Shell(new VirtualFileSystem());
    const result = await shell.run('echo hello | cat');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello\n');
  });

  it('pipes file contents through cat into echo', async () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/a.txt', 'piped-content');
    const shell = new Shell(vfs);
    const result = await shell.run('cat a.txt | echo prefix');
    expect(result.stdout).toBe('prefix\npiped-content\n');
  });

  it('pipes stdin into a run script via the stdin sandbox variable', async () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/echoStdin.js', 'console.log(stdin.toUpperCase());');
    const shell = new Shell(vfs);
    const result = await shell.run('echo hello | run echoStdin.js');
    expect(result.exitCode).toBe(0);
    // stdin carries echo's own trailing newline through the pipe, and console.log adds one
    // more of its own — matching real console.log semantics (it always appends a newline).
    expect(result.stdout).toBe('HELLO\n\n');
  });
});

describe('Shell: redirection', () => {
  it('redirects echo output to a file instead of stdout', async () => {
    const vfs = new VirtualFileSystem();
    const shell = new Shell(vfs);
    const result = await shell.run('echo hello > out.txt');
    expect(result.stdout).toBe('');
    expect(vfs.readFile('/out.txt')).toBe('hello\n');
  });

  it('append redirection appends to an existing file', async () => {
    const vfs = new VirtualFileSystem();
    const shell = new Shell(vfs);
    await shell.run('echo one > out.txt');
    await shell.run('echo two >> out.txt');
    expect(vfs.readFile('/out.txt')).toBe('one\ntwo\n');
  });
});
