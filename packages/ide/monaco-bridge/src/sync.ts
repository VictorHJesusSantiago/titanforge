import type { VirtualFileSystem } from '@titanforge/vfs';

/**
 * The minimal slice of Monaco's `ITextModel` this package actually needs. Extracting this as an
 * interface (rather than importing `monaco.editor.ITextModel` directly) is what lets the sync
 * logic below be unit-tested with a plain in-memory fake — no DOM, no Monaco worker environment,
 * no browser required — while `providers.ts` wires the real thing at the edges.
 */
export interface ModelLike {
  getValue(): string;
  setValue(value: string): void;
  onDidChangeContent(listener: () => void): { dispose(): void };
}

export interface Disposable {
  dispose(): void;
}

/**
 * Two-way sync between a VFS file and a Monaco model:
 *  - Model edits (real keystrokes in the editor) write through to the VFS.
 *  - VFS writes from elsewhere (the shell's `run`/`echo >`, another tab, a snapshot restore)
 *    push into the model so it reflects the latest content.
 *
 * A single boolean guard (`applyingFromVfs`) prevents the obvious feedback loop: without it, an
 * external VFS write would call `model.setValue`, which would fire `onDidChangeContent`, which
 * would write the (unchanged) content straight back to the VFS, notifying watchers again, and so
 * on. Real bidirectional sync always needs exactly this kind of "who's driving right now" guard.
 */
export function syncModelToVfs(vfs: VirtualFileSystem, path: string, model: ModelLike): Disposable {
  let applyingFromVfs = false;

  const contentSub = model.onDidChangeContent(() => {
    if (applyingFromVfs) return;
    const value = model.getValue();
    if (vfs.exists(path) && vfs.readFile(path) === value) return;
    vfs.writeFile(path, value);
  });

  const unwatch = vfs.watch(path, (event) => {
    if (event.type !== 'write') return;
    if (!vfs.exists(path)) return;
    const content = vfs.readFile(path);
    if (content === model.getValue()) return; // avoid a redundant setValue (would move cursor)
    applyingFromVfs = true;
    try {
      model.setValue(content);
    } finally {
      applyingFromVfs = false;
    }
  });

  return {
    dispose() {
      contentSub.dispose();
      unwatch();
    },
  };
}

/** Seed a freshly-created model with the VFS file's current content, creating the file (empty)
 *  first if it doesn't exist yet — used right after `monaco.editor.createModel(...)`. */
export function primeModelFromVfs(vfs: VirtualFileSystem, path: string): string {
  if (!vfs.exists(path)) {
    vfs.writeFile(path, '');
  }
  return vfs.readFile(path);
}
