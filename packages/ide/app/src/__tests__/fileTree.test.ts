import { describe, it, expect } from 'vitest';
import { VirtualFileSystem } from '@titanforge/vfs';
import { buildFileTree, flattenFileTree } from '../fileTree.js';

describe('buildFileTree', () => {
  it('builds a nested tree reflecting real VFS structure', () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/src/index.ts', '');
    vfs.writeFile('/src/utils/helpers.ts', '');
    vfs.writeFile('/package.json', '');

    const tree = buildFileTree(vfs);
    expect(tree.type).toBe('dir');
    expect(tree.path).toBe('/');

    const src = tree.children?.find((c) => c.name === 'src');
    expect(src?.type).toBe('dir');
    const utils = src?.children?.find((c) => c.name === 'utils');
    expect(utils?.type).toBe('dir');
    expect(utils?.children?.[0]?.name).toBe('helpers.ts');
    expect(utils?.children?.[0]?.type).toBe('file');
  });

  it('sorts directories before files, alphabetically within each group', () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/zebra.ts', '');
    vfs.writeFile('/apple.ts', '');
    vfs.mkdir('/zdir');
    vfs.mkdir('/adir');

    const tree = buildFileTree(vfs);
    const names = tree.children?.map((c) => c.name);
    expect(names).toEqual(['adir', 'zdir', 'apple.ts', 'zebra.ts']);
  });

  it('can be rooted at a subdirectory', () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/src/index.ts', '');
    const tree = buildFileTree(vfs, '/src');
    expect(tree.name).toBe('src');
    expect(tree.type).toBe('dir');
    expect(tree.children?.[0]?.name).toBe('index.ts');
  });

  it('returns a file node when rooted directly at a file', () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/a.txt', 'x');
    const tree = buildFileTree(vfs, '/a.txt');
    expect(tree).toEqual({ name: 'a.txt', path: '/a.txt', type: 'file' });
  });

  it('produces an empty children array for an empty directory', () => {
    const vfs = new VirtualFileSystem();
    vfs.mkdir('/empty');
    const tree = buildFileTree(vfs, '/empty');
    expect(tree.children).toEqual([]);
  });
});

describe('flattenFileTree', () => {
  it('flattens depth-first with correct depth tracking', () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/src/a.ts', '');
    vfs.writeFile('/root.ts', '');
    const tree = buildFileTree(vfs);
    const flat = flattenFileTree(tree);

    expect(flat[0]?.node.path).toBe('/');
    expect(flat[0]?.depth).toBe(0);

    const srcEntry = flat.find((e) => e.node.path === '/src');
    expect(srcEntry?.depth).toBe(1);
    const aEntry = flat.find((e) => e.node.path === '/src/a.ts');
    expect(aEntry?.depth).toBe(2);
    const rootTs = flat.find((e) => e.node.path === '/root.ts');
    expect(rootTs?.depth).toBe(1);
  });

  it('flattening a single file node returns just that node', () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/a.txt', 'x');
    const tree = buildFileTree(vfs, '/a.txt');
    expect(flattenFileTree(tree)).toEqual([{ node: tree, depth: 0 }]);
  });
});
