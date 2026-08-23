/**
 * Path handling for the virtual filesystem. Every path is treated as POSIX-style and absolute
 * ("/src/index.ts"); a leading slash is implied even if the caller omits it. We normalize once
 * here so every consumer (readFile, watch, stat, ...) agrees on what a path "is" — no trailing
 * slashes, no empty segments from doubled slashes, "." segments collapsed, ".." resolved.
 */

/** Split a raw path into normalized, non-empty segments. `/a//b/./c/../d` -> ['a', 'b', 'd']. */
export function segmentsOf(rawPath: string): string[] {
  const parts = rawPath.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out;
}

/** Normalize a path back to its canonical absolute string form. */
export function normalizePath(rawPath: string): string {
  const segments = segmentsOf(rawPath);
  return '/' + segments.join('/');
}

/** The parent directory's normalized path, and the final segment (basename). Root has no parent. */
export function splitParent(rawPath: string): { parent: string; name: string } {
  const segments = segmentsOf(rawPath);
  if (segments.length === 0) {
    throw new Error('root has no parent');
  }
  const name = segments[segments.length - 1] as string;
  const parent = '/' + segments.slice(0, -1).join('/');
  return { parent, name };
}

/** True if `ancestor` is `descendant` itself, or a path-prefix ancestor of it. */
export function isAncestorOrSelf(ancestor: string, descendant: string): boolean {
  const a = segmentsOf(ancestor);
  const d = segmentsOf(descendant);
  if (a.length > d.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== d[i]) return false;
  }
  return true;
}
