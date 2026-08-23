import { describe, it, expect, vi } from 'vitest';
import { VirtualFileSystem } from '@titanforge/vfs';
import { syncModelToVfs, primeModelFromVfs } from '../sync.js';
import type { ModelLike } from '../sync.js';

/** A minimal fake standing in for a real Monaco `ITextModel`, sufficient to exercise the pure
 *  sync logic without any DOM or Monaco runtime — the point of extracting `ModelLike`. */
class FakeModel implements ModelLike {
  private value: string;
  private listeners: Array<() => void> = [];

  constructor(initial = '') {
    this.value = initial;
  }

  getValue(): string {
    return this.value;
  }

  setValue(value: string): void {
    this.value = value;
    for (const l of this.listeners) l();
  }

  /** Simulates a real editor keystroke: changes the value AND fires the change event, exactly
   *  like Monaco does when the user types (unlike setValue used for programmatic resets, this
   *  models "the user edited the buffer"). Monaco's real onDidChangeContent fires on any content
   *  mutation including setValue, so this reuses setValue's own event firing. */
  typeInto(value: string): void {
    this.setValue(value);
  }

  onDidChangeContent(listener: () => void): { dispose(): void } {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const idx = this.listeners.indexOf(listener);
        if (idx !== -1) this.listeners.splice(idx, 1);
      },
    };
  }
}

describe('syncModelToVfs: model -> vfs', () => {
  it('writes model edits through to the VFS', () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/a.ts', 'initial');
    const model = new FakeModel('initial');
    syncModelToVfs(vfs, '/a.ts', model);

    model.typeInto('edited by user');
    expect(vfs.readFile('/a.ts')).toBe('edited by user');
  });

  it('creates the VFS file if it does not exist yet', () => {
    const vfs = new VirtualFileSystem();
    const model = new FakeModel('');
    syncModelToVfs(vfs, '/new.ts', model);
    model.typeInto('brand new content');
    expect(vfs.readFile('/new.ts')).toBe('brand new content');
  });

  it('does not write to the VFS if the model value did not actually change', () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/a.ts', 'same');
    const model = new FakeModel('same');
    syncModelToVfs(vfs, '/a.ts', model);
    const versionBefore = vfs.getFileVersion('/a.ts');
    model.typeInto('same'); // no real change
    expect(vfs.getFileVersion('/a.ts')).toBe(versionBefore);
  });
});

describe('syncModelToVfs: vfs -> model', () => {
  it('pushes external VFS writes into the model', () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/a.ts', 'from editor');
    const model = new FakeModel('from editor');
    syncModelToVfs(vfs, '/a.ts', model);

    vfs.writeFile('/a.ts', 'written by the shell'); // e.g. `run` or `echo >` touching the file
    expect(model.getValue()).toBe('written by the shell');
  });

  it('does not react to writes to unrelated VFS paths', () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/a.ts', 'content a');
    vfs.writeFile('/b.ts', 'content b');
    const model = new FakeModel('content a');
    syncModelToVfs(vfs, '/a.ts', model);

    vfs.writeFile('/b.ts', 'changed');
    expect(model.getValue()).toBe('content a');
  });

  it('does not cause an infinite feedback loop between model and vfs', () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/a.ts', 'x');
    const model = new FakeModel('x');
    const setValueSpy = vi.spyOn(model, 'setValue');
    syncModelToVfs(vfs, '/a.ts', model);

    vfs.writeFile('/a.ts', 'y');
    // setValue should be called exactly once by the vfs->model push, not recursively re-triggered
    // by the write-through that a naive (unguarded) implementation would perform.
    expect(setValueSpy).toHaveBeenCalledTimes(1);
    expect(vfs.getFileVersion('/a.ts')).toBe(2); // only the original external write bumped it
  });
});

describe('syncModelToVfs: dispose', () => {
  it('stops all synchronization after dispose', () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/a.ts', 'x');
    const model = new FakeModel('x');
    const handle = syncModelToVfs(vfs, '/a.ts', model);
    handle.dispose();

    model.typeInto('edited after dispose');
    expect(vfs.readFile('/a.ts')).toBe('x');

    vfs.writeFile('/a.ts', 'external after dispose');
    expect(model.getValue()).toBe('edited after dispose');
  });
});

describe('primeModelFromVfs', () => {
  it('returns existing file content unchanged', () => {
    const vfs = new VirtualFileSystem();
    vfs.writeFile('/a.ts', 'existing content');
    expect(primeModelFromVfs(vfs, '/a.ts')).toBe('existing content');
  });

  it('creates an empty file and returns empty string when the file is missing', () => {
    const vfs = new VirtualFileSystem();
    expect(primeModelFromVfs(vfs, '/new.ts')).toBe('');
    expect(vfs.exists('/new.ts')).toBe(true);
  });
});
