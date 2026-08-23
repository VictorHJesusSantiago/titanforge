export { VirtualFileSystem } from './vfs.js';
export type { Stat, WatchEvent, WatchEventType, WatchCallback, VfsSnapshot } from './vfs.js';
export { VfsError, notFound, alreadyExists, notADirectory, isADirectory, notEmpty } from './errors.js';
export { normalizePath, segmentsOf, splitParent, isAncestorOrSelf } from './path.js';
