// This package is primarily a Vite entry app (see index.html -> src/main.ts), not a library
// consumed by other packages. `src/index.ts` exists to match this repo's package.json/exports
// convention and to give the pure logic (fileTree) an importable, testable surface.
export { buildFileTree, flattenFileTree } from './fileTree.js';
export type { FileTreeNode } from './fileTree.js';
