import { describe, it, expect, vi } from 'vitest';
import { VirtualFileSystem } from '../vfs.js';
import { VfsError } from '../errors.js';

describe('VirtualFileSystem: files', () => {
  it('writes and reads a file at the root', () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/a.txt', 'hello');
    expect(fs.readFile('/a.txt')).toBe('hello');
  });

  it('writeFile auto-creates missing parent directories', () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/src/nested/deep/index.ts', 'export {}');
    expect(fs.readFile('/src/nested/deep/index.ts')).toBe('export {}');
    expect(fs.exists('/src')).toBe(true);
    expect(fs.exists('/src/nested')).toBe(true);
    expect(fs.exists('/src/nested/deep')).toBe(true);
  });

  it('overwrites an existing file in place and bumps its version', () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/a.txt', 'v1');
    expect(fs.getFileVersion('/a.txt')).toBe(1);
    fs.writeFile('/a.txt', 'v2');
    expect(fs.readFile('/a.txt')).toBe('v2');
    expect(fs.getFileVersion('/a.txt')).toBe(2);
  });

  it('readFile on a missing path throws ENOENT', () => {
    const fs = new VirtualFileSystem();
    expect(() => fs.readFile('/nope.txt')).toThrow(VfsError);
    try {
      fs.readFile('/nope.txt');
    } catch (e) {
      expect((e as VfsError).code).toBe('ENOENT');
    }
  });

  it('readFile on a directory throws EISDIR', () => {
    const fs = new VirtualFileSystem();
    fs.mkdir('/dir');
    expect(() => fs.readFile('/dir')).toThrow(VfsError);
  });

  it('exists is false for anything never created', () => {
    const fs = new VirtualFileSystem();
    expect(fs.exists('/x')).toBe(false);
    fs.writeFile('/x', '1');
    expect(fs.exists('/x')).toBe(true);
  });
});

describe('VirtualFileSystem: directories', () => {
  it('mkdir creates a single directory whose parent exists', () => {
    const fs = new VirtualFileSystem();
    fs.mkdir('/src');
    expect(fs.stat('/src').type).toBe('dir');
  });

  it('mkdir without recursive throws ENOENT when parent is missing', () => {
    const fs = new VirtualFileSystem();
    expect(() => fs.mkdir('/a/b')).toThrow(VfsError);
  });

  it('mkdir without recursive throws EEXIST if the directory is already there', () => {
    const fs = new VirtualFileSystem();
    fs.mkdir('/src');
    expect(() => fs.mkdir('/src')).toThrow(VfsError);
  });

  it('mkdir recursive builds every missing intermediate directory (mkdir -p)', () => {
    const fs = new VirtualFileSystem();
    fs.mkdir('/a/b/c', { recursive: true });
    expect(fs.exists('/a')).toBe(true);
    expect(fs.exists('/a/b')).toBe(true);
    expect(fs.exists('/a/b/c')).toBe(true);
  });

  it('mkdir recursive is a no-op (does not throw) if the directory already exists', () => {
    const fs = new VirtualFileSystem();
    fs.mkdir('/a/b', { recursive: true });
    expect(() => fs.mkdir('/a/b', { recursive: true })).not.toThrow();
  });

  it('readdir lists direct children only, sorted, files and dirs together', () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/proj/b.ts', '');
    fs.writeFile('/proj/a.ts', '');
    fs.mkdir('/proj/sub');
    expect(fs.readdir('/proj')).toEqual(['a.ts', 'b.ts', 'sub']);
  });

  it('readdir does not reach into grandchildren', () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/proj/sub/deep.ts', '');
    expect(fs.readdir('/proj')).toEqual(['sub']);
  });

  it('readdir on root works with no leading path created', () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/x.txt', '');
    expect(fs.readdir('/')).toEqual(['x.txt']);
  });

  it('rm removes a file', () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/a.txt', '1');
    fs.rm('/a.txt');
    expect(fs.exists('/a.txt')).toBe(false);
  });

  it('rm on a non-empty directory without recursive throws ENOTEMPTY', () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/dir/f.txt', '1');
    expect(() => fs.rm('/dir')).toThrow(VfsError);
  });

  it('rm recursive removes a directory and everything under it', () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/dir/sub/f.txt', '1');
    fs.rm('/dir', { recursive: true });
    expect(fs.exists('/dir')).toBe(false);
    expect(fs.exists('/dir/sub/f.txt')).toBe(false);
  });

  it('rm on a missing path throws ENOENT', () => {
    const fs = new VirtualFileSystem();
    expect(() => fs.rm('/nope')).toThrow(VfsError);
  });

  it('mv renames/moves a file, and fails if destination exists', () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/a.txt', 'content');
    fs.mv('/a.txt', '/b/renamed.txt');
    expect(fs.exists('/a.txt')).toBe(false);
    expect(fs.readFile('/b/renamed.txt')).toBe('content');

    fs.writeFile('/c.txt', 'other');
    expect(() => fs.mv('/c.txt', '/b/renamed.txt')).toThrow(VfsError);
  });

  it('cp copies file content to a new path, leaving the original intact', () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/a.txt', 'content');
    fs.cp('/a.txt', '/b.txt');
    expect(fs.readFile('/a.txt')).toBe('content');
    expect(fs.readFile('/b.txt')).toBe('content');
  });

  it('stat reports type, size and version for files, and type/size for dirs', () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/a.txt', 'hello');
    const fileStat = fs.stat('/a.txt');
    expect(fileStat.type).toBe('file');
    expect(fileStat.size).toBe(5);
    expect(fileStat.version).toBe(1);

    fs.mkdir('/dir');
    fs.writeFile('/dir/x.txt', '');
    const dirStat = fs.stat('/dir');
    expect(dirStat.type).toBe('dir');
    expect(dirStat.size).toBe(1);
  });

  it('paths normalize away double slashes, ./ and ../', () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/a/b/../c.txt', 'x');
    expect(fs.readFile('/a/c.txt')).toBe('x');
    expect(fs.readFile('//a//c.txt')).toBe('x');
    expect(fs.readFile('/a/./c.txt')).toBe('x');
  });
});

describe('VirtualFileSystem: watch', () => {
  it('fires on a write directly at the watched path', () => {
    const fs = new VirtualFileSystem();
    const cb = vi.fn();
    fs.watch('/a.txt', cb);
    fs.writeFile('/a.txt', 'hi');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ type: 'write', path: '/a.txt' });
  });

  it('fires for writes to files nested under a watched directory', () => {
    const fs = new VirtualFileSystem();
    const cb = vi.fn();
    fs.watch('/src', cb);
    fs.writeFile('/src/deep/nested/file.ts', 'x');
    expect(cb).toHaveBeenCalled();
    const calledPaths = cb.mock.calls.map((c) => (c[0] as { path: string }).path);
    expect(calledPaths).toContain('/src/deep/nested/file.ts');
  });

  it('does NOT fire for writes outside the watched subtree', () => {
    const fs = new VirtualFileSystem();
    const cb = vi.fn();
    fs.watch('/src', cb);
    fs.writeFile('/other/file.ts', 'x');
    expect(cb).not.toHaveBeenCalled();
  });

  it('does not fire for a sibling directory that merely shares a prefix', () => {
    const fs = new VirtualFileSystem();
    const cb = vi.fn();
    fs.watch('/src', cb);
    fs.writeFile('/src-other/file.ts', 'x'); // shares string prefix "src" but is a different dir
    expect(cb).not.toHaveBeenCalled();
  });

  it('fires delete events', () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/a.txt', '1');
    const cb = vi.fn();
    fs.watch('/a.txt', cb);
    fs.rm('/a.txt');
    expect(cb).toHaveBeenCalledWith({ type: 'delete', path: '/a.txt' });
  });

  it('unsubscribe stops further notifications', () => {
    const fs = new VirtualFileSystem();
    const cb = vi.fn();
    const unsubscribe = fs.watch('/a.txt', cb);
    fs.writeFile('/a.txt', '1');
    unsubscribe();
    fs.writeFile('/a.txt', '2');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('watching root fires on any change anywhere', () => {
    const fs = new VirtualFileSystem();
    const cb = vi.fn();
    fs.watch('/', cb);
    fs.writeFile('/deep/nested/file.ts', 'x');
    fs.mkdir('/another');
    fs.rm('/deep', { recursive: true });
    expect(cb.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('multiple watchers on different paths only get their own events', () => {
    const fs = new VirtualFileSystem();
    const cbA = vi.fn();
    const cbB = vi.fn();
    fs.watch('/a', cbA);
    fs.watch('/b', cbB);
    fs.writeFile('/a/f.txt', '1');
    // writeFile also mkdir -p's the parent, so cbA sees both the implicit mkdir of /a and the
    // write of /a/f.txt — both are real events under /a, just not exactly one of them.
    expect(cbA).toHaveBeenCalled();
    expect(cbA).toHaveBeenCalledWith({ type: 'write', path: '/a/f.txt' });
    expect(cbB).not.toHaveBeenCalled();
  });
});

describe('VirtualFileSystem: snapshot / restore', () => {
  it('round-trips a tree of files and directories through toJSON/fromJSON', () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/src/index.ts', 'export const x = 1;');
    fs.writeFile('/package.json', '{}');
    fs.mkdir('/empty-dir');

    const snapshot = fs.toJSON();
    const restored = VirtualFileSystem.fromJSON(snapshot);

    expect(restored.readFile('/src/index.ts')).toBe('export const x = 1;');
    expect(restored.readFile('/package.json')).toBe('{}');
    expect(restored.exists('/empty-dir')).toBe(true);
    expect(restored.readdir('/')).toEqual(['empty-dir', 'package.json', 'src']);
  });

  it('instance fromJSON replaces the tree in place and notifies root watchers', () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/old.txt', 'old');
    const snapshot = VirtualFileSystem.fromJSON({
      type: 'dir',
      children: { 'new.txt': { type: 'file', content: 'new' } },
    }).toJSON();

    const cb = vi.fn();
    fs.watch('/', cb);
    fs.fromJSON(snapshot);

    expect(fs.exists('/old.txt')).toBe(false);
    expect(fs.readFile('/new.txt')).toBe('new');
    expect(cb).toHaveBeenCalled();
  });

  it('snapshot is plain JSON-serializable (survives JSON.stringify/parse)', () => {
    const fs = new VirtualFileSystem();
    fs.writeFile('/a/b/c.txt', 'deep content');
    const roundTripped = JSON.parse(JSON.stringify(fs.toJSON()));
    const restored = VirtualFileSystem.fromJSON(roundTripped);
    expect(restored.readFile('/a/b/c.txt')).toBe('deep content');
  });
});
