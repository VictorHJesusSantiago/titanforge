import type { VirtualFileSystem } from '@titanforge/vfs';

/** A pure UI-tree node computed from the VFS — no DOM involved, so this is the one piece of
 *  app-package logic worth unit-testing directly (per this project's "extract the pure wiring
 *  logic out of the DOM-assembly layer" convention). */
export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileTreeNode[];
}

/** Walk the VFS starting at `rootPath` (default "/") and build the nested tree structure a file
 *  tree UI would render: directories sorted before files, each level sorted alphabetically. This
 *  is deliberately synchronous and DOM-free — the caller renders it however it likes. */
export function buildFileTree(vfs: VirtualFileSystem, rootPath = '/'): FileTreeNode {
  const stat = vfs.stat(rootPath);
  const name = rootPath === '/' ? '/' : (rootPath.split('/').pop() ?? rootPath);

  if (stat.type === 'file') {
    return { name, path: rootPath, type: 'file' };
  }

  const entries = vfs.readdir(rootPath);
  const children = entries.map((entryName) => {
    const childPath = rootPath === '/' ? `/${entryName}` : `${rootPath}/${entryName}`;
    return buildFileTree(vfs, childPath);
  });

  children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { name, path: rootPath, type: 'dir', children };
}

/** Flatten a tree into a depth-first list of {path, depth} pairs — convenient for rendering as
 *  an indented list without recursive DOM construction logic living inline in main.ts. */
export function flattenFileTree(node: FileTreeNode, depth = 0): Array<{ node: FileTreeNode; depth: number }> {
  const out: Array<{ node: FileTreeNode; depth: number }> = [{ node, depth }];
  if (node.children) {
    for (const child of node.children) {
      out.push(...flattenFileTree(child, depth + 1));
    }
  }
  return out;
}
