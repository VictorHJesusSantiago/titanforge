import { normalizePath, segmentsOf, splitParent, isAncestorOrSelf } from './path.js';
import {
  notFound,
  alreadyExists,
  notADirectory,
  isADirectory,
  notEmpty,
} from './errors.js';

/**
 * A real tree, not a flat `Map<path, content>` wearing a filesystem costume: directories are
 * actual nodes holding a `Map` of child nodes, so `readdir` walks real structure and nested
 * `mkdir -p` creation really does build intermediate directory nodes.
 */
interface FileNode {
  type: 'file';
  content: string;
  mtimeMs: number;
  /** Bumped on every write; consumers (the language service) use this to know a file changed
   *  without diffing content. */
  version: number;
}

interface DirNode {
  type: 'dir';
  children: Map<string, VNode>;
  mtimeMs: number;
}

type VNode = FileNode | DirNode;

export interface Stat {
  type: 'file' | 'dir';
  size: number;
  mtimeMs: number;
  /** Only meaningful for files; directories report 0. */
  version: number;
}

export type WatchEventType = 'write' | 'delete' | 'mkdir';

export interface WatchEvent {
  type: WatchEventType;
  /** The exact path that changed (which may be the watched path itself, or something under it). */
  path: string;
}

export type WatchCallback = (event: WatchEvent) => void;

/** JSON-serializable snapshot shape, used by toJSON()/fromJSON(). */
export type VfsSnapshot =
  | { type: 'file'; content: string }
  | { type: 'dir'; children: Record<string, VfsSnapshot> };

interface Watcher {
  path: string;
  callback: WatchCallback;
}

function makeDir(): DirNode {
  return { type: 'dir', children: new Map(), mtimeMs: Date.now() };
}

export class VirtualFileSystem {
  private root: DirNode = makeDir();
  private watchers: Watcher[] = [];

  // ---- traversal helpers -------------------------------------------------

  /** Resolve a path to its node, or undefined if any segment along the way is missing. */
  private lookup(path: string): VNode | undefined {
    const segments = segmentsOf(path);
    let node: VNode = this.root;
    for (const segment of segments) {
      if (node.type !== 'dir') return undefined;
      const next = node.children.get(segment);
      if (!next) return undefined;
      node = next;
    }
    return node;
  }

  private lookupDir(path: string): DirNode {
    const node = this.lookup(path);
    if (!node) throw notFound(path);
    if (node.type !== 'dir') throw notADirectory(path);
    return node;
  }

  // ---- reads ---------------------------------------------------------------

  exists(rawPath: string): boolean {
    return this.lookup(rawPath) !== undefined;
  }

  readFile(rawPath: string): string {
    const path = normalizePath(rawPath);
    const node = this.lookup(path);
    if (!node) throw notFound(path);
    if (node.type !== 'file') throw isADirectory(path);
    return node.content;
  }

  /** File version counter — bumps on every writeFile, used by consumers to detect changes cheaply. */
  getFileVersion(rawPath: string): number {
    const path = normalizePath(rawPath);
    const node = this.lookup(path);
    if (!node) throw notFound(path);
    if (node.type !== 'file') throw isADirectory(path);
    return node.version;
  }

  readdir(rawPath: string): string[] {
    const path = normalizePath(rawPath);
    const dir = path === '/' ? this.root : this.lookupDir(path);
    return [...dir.children.keys()].sort();
  }

  stat(rawPath: string): Stat {
    const path = normalizePath(rawPath);
    const node = path === '/' ? this.root : this.lookup(path);
    if (!node) throw notFound(path);
    if (node.type === 'file') {
      return { type: 'file', size: node.content.length, mtimeMs: node.mtimeMs, version: node.version };
    }
    return { type: 'dir', size: node.children.size, mtimeMs: node.mtimeMs, version: 0 };
  }

  // ---- writes ---------------------------------------------------------------

  /** Create a directory. `recursive: true` behaves like `mkdir -p` (creates missing parents,
   *  and does not error if the directory already exists). Without it, the parent must already
   *  exist and the target must not. */
  mkdir(rawPath: string, options?: { recursive?: boolean }): void {
    const path = normalizePath(rawPath);
    const recursive = options?.recursive ?? false;
    const segments = segmentsOf(path);
    if (segments.length === 0) return; // root always exists

    if (!recursive) {
      const { parent, name } = splitParent(path);
      const parentDir = this.lookupDir(parent);
      if (parentDir.children.has(name)) throw alreadyExists(path);
      parentDir.children.set(name, makeDir());
      this.notify(path, 'mkdir');
      return;
    }

    let node: DirNode = this.root;
    let built = '';
    for (const segment of segments) {
      built = built + '/' + segment;
      let next = node.children.get(segment);
      if (!next) {
        next = makeDir();
        node.children.set(segment, next);
        this.notify(built, 'mkdir');
      }
      if (next.type !== 'dir') throw notADirectory(built);
      node = next;
    }
  }

  /** Write file content, creating the file if absent and updating it in place otherwise.
   *  Parent directories are created automatically (mkdir -p semantics) for ergonomics — this
   *  mirrors how editors/terminals actually want to "just save a file". */
  writeFile(rawPath: string, content: string): void {
    const path = normalizePath(rawPath);
    const { parent, name } = splitParent(path);
    this.mkdir(parent, { recursive: true });
    const parentDir = this.lookupDir(parent);
    const existing = parentDir.children.get(name);
    if (existing && existing.type === 'dir') throw isADirectory(path);
    if (existing) {
      existing.content = content;
      existing.mtimeMs = Date.now();
      existing.version += 1;
    } else {
      parentDir.children.set(name, { type: 'file', content, mtimeMs: Date.now(), version: 1 });
    }
    this.notify(path, 'write');
  }

  rm(rawPath: string, options?: { recursive?: boolean }): void {
    const path = normalizePath(rawPath);
    const recursive = options?.recursive ?? false;
    if (path === '/') {
      if (!recursive) throw notEmpty(path);
      this.root = makeDir();
      this.notify(path, 'delete');
      return;
    }
    const { parent, name } = splitParent(path);
    const parentDir = this.lookupDir(parent);
    const node = parentDir.children.get(name);
    if (!node) throw notFound(path);
    if (node.type === 'dir' && node.children.size > 0 && !recursive) throw notEmpty(path);
    parentDir.children.delete(name);
    this.notify(path, 'delete');
  }

  /** Move/rename. Fails if the destination already exists. */
  mv(rawFrom: string, rawTo: string): void {
    const from = normalizePath(rawFrom);
    const to = normalizePath(rawTo);
    if (this.exists(to)) throw alreadyExists(to);
    const { parent: fromParent, name: fromName } = splitParent(from);
    const fromDir = this.lookupDir(fromParent);
    const node = fromDir.children.get(fromName);
    if (!node) throw notFound(from);
    const { parent: toParent, name: toName } = splitParent(to);
    this.mkdir(toParent, { recursive: true });
    const toDir = this.lookupDir(toParent);
    fromDir.children.delete(fromName);
    toDir.children.set(toName, node);
    this.notify(from, 'delete');
    this.notify(to, node.type === 'dir' ? 'mkdir' : 'write');
  }

  /** Copy a file (directories not supported — mirrors the honest single-file scope of `cp` in
   *  the shell package). */
  cp(rawFrom: string, rawTo: string): void {
    const from = normalizePath(rawFrom);
    const content = this.readFile(from);
    this.writeFile(rawTo, content);
  }

  // ---- watching ---------------------------------------------------------------

  /** Fire `callback` for every write/delete/mkdir at or under `path`. Returns an unsubscribe
   *  function. Events for unrelated subtrees never fire — this is a real prefix check, not a
   *  "watch everything and hope" shortcut. */
  watch(rawPath: string, callback: WatchCallback): () => void {
    const path = normalizePath(rawPath);
    const watcher: Watcher = { path, callback };
    this.watchers.push(watcher);
    return () => {
      const index = this.watchers.indexOf(watcher);
      if (index !== -1) this.watchers.splice(index, 1);
    };
  }

  private notify(path: string, type: WatchEventType): void {
    for (const watcher of this.watchers) {
      if (isAncestorOrSelf(watcher.path, path)) {
        watcher.callback({ type, path });
      }
    }
  }

  // ---- snapshot / restore ---------------------------------------------------------------

  toJSON(): VfsSnapshot {
    return dirToSnapshot(this.root);
  }

  static fromJSON(snapshot: VfsSnapshot): VirtualFileSystem {
    const fs = new VirtualFileSystem();
    if (snapshot.type !== 'dir') throw new Error('root snapshot must be a directory');
    fs.root = snapshotToDir(snapshot);
    return fs;
  }

  /** Replace the entire tree in place from a snapshot (useful for reloading into an existing
   *  instance that other code already holds a reference to). */
  fromJSON(snapshot: VfsSnapshot): void {
    if (snapshot.type !== 'dir') throw new Error('root snapshot must be a directory');
    this.root = snapshotToDir(snapshot);
    this.notify('/', 'write');
  }
}

function dirToSnapshot(dir: DirNode): VfsSnapshot {
  const children: Record<string, VfsSnapshot> = {};
  for (const [name, node] of dir.children) {
    children[name] = node.type === 'file' ? { type: 'file', content: node.content } : dirToSnapshot(node);
  }
  return { type: 'dir', children };
}

function snapshotToDir(snapshot: VfsSnapshot): DirNode {
  if (snapshot.type !== 'dir') throw new Error('expected directory snapshot');
  const dir = makeDir();
  for (const [name, child] of Object.entries(snapshot.children)) {
    if (child.type === 'file') {
      dir.children.set(name, { type: 'file', content: child.content, mtimeMs: Date.now(), version: 1 });
    } else {
      dir.children.set(name, snapshotToDir(child));
    }
  }
  return dir;
}
