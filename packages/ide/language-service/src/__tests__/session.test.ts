import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFileSystem } from '@titanforge/vfs';
import { LanguageServiceSession } from '../session.js';

describe('LanguageServiceSession: diagnostics', () => {
  let vfs: VirtualFileSystem;
  let session: LanguageServiceSession;

  beforeEach(() => {
    vfs = new VirtualFileSystem();
    session = new LanguageServiceSession(vfs);
  });

  it('reports a real type error at the right position', () => {
    const source = 'const x: number = "not a number";\n';
    vfs.writeFile('/index.ts', source);
    const diagnostics = session.getDiagnostics('/index.ts');
    expect(diagnostics.length).toBeGreaterThan(0);
    const typeError = diagnostics.find((d) => d.category === 'error');
    expect(typeError).toBeDefined();
    // TypeScript reports assignability errors at the assignment target ('x'), not the RHS.
    const expectedStart = source.indexOf('x');
    expect(typeError?.start).toBe(expectedStart);
    expect(typeError?.message.toLowerCase()).toContain('string');
  });

  it('reports no diagnostics for valid, well-typed code', () => {
    vfs.writeFile('/ok.ts', 'const y: number = 42;\nexport { y };\n');
    expect(session.getDiagnostics('/ok.ts')).toEqual([]);
  });

  it('re-checks after the file is edited in the VFS (version bump picked up)', () => {
    vfs.writeFile('/edit.ts', 'const z: number = 1;\n');
    expect(session.getDiagnostics('/edit.ts')).toEqual([]);
    vfs.writeFile('/edit.ts', 'const z: number = "broken";\n');
    const diagnostics = session.getDiagnostics('/edit.ts');
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it('reports a syntax error for malformed code', () => {
    vfs.writeFile('/bad.ts', 'const a = ;\n');
    const diagnostics = session.getDiagnostics('/bad.ts');
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it('catches an undefined-symbol reference as a semantic error', () => {
    vfs.writeFile('/undef.ts', 'console.log(totallyUndefinedName);\n');
    const diagnostics = session.getDiagnostics('/undef.ts');
    expect(diagnostics.some((d) => d.message.toLowerCase().includes('cannot find name'))).toBe(true);
  });
});

describe('LanguageServiceSession: completions', () => {
  let vfs: VirtualFileSystem;
  let session: LanguageServiceSession;

  beforeEach(() => {
    vfs = new VirtualFileSystem();
    session = new LanguageServiceSession(vfs);
  });

  it('offers real member completions on a typed object', () => {
    const source = 'const point = { x: 1, y: 2 };\npoint.\n';
    vfs.writeFile('/completions.ts', source);
    const position = source.indexOf('point.\n') + 'point.'.length;
    const entries = session.getCompletionsAt('/completions.ts', position);
    const names = entries.map((e) => e.name);
    expect(names).toContain('x');
    expect(names).toContain('y');
  });

  it('offers completions for an imported symbol across two files in the VFS', () => {
    vfs.writeFile('/lib.ts', 'export interface Widget {\n  label: string;\n  count: number;\n}\nexport const widget: Widget = { label: "a", count: 1 };\n');
    const source = 'import { widget } from "./lib";\nwidget.\n';
    vfs.writeFile('/main.ts', source);
    const position = source.indexOf('widget.\n', source.indexOf('import')) + 'widget.'.length;
    const entries = session.getCompletionsAt('/main.ts', position);
    const names = entries.map((e) => e.name);
    expect(names).toContain('label');
    expect(names).toContain('count');
  });
});

describe('LanguageServiceSession: hover', () => {
  let vfs: VirtualFileSystem;
  let session: LanguageServiceSession;

  beforeEach(() => {
    vfs = new VirtualFileSystem();
    session = new LanguageServiceSession(vfs);
  });

  it('returns real type information for a variable', () => {
    const source = 'const total: number = 5 + 5;\n';
    vfs.writeFile('/hover.ts', source);
    const position = source.indexOf('total') + 1;
    const hover = session.getHoverInfo('/hover.ts', position);
    expect(hover).toBeDefined();
    expect(hover?.text).toContain('total');
    expect(hover?.text).toContain('number');
  });

  it('returns function signature info on hover over a call', () => {
    const source = 'function add(a: number, b: number): number {\n  return a + b;\n}\nadd(1, 2);\n';
    vfs.writeFile('/fn.ts', source);
    const callSite = source.lastIndexOf('add(');
    const position = callSite + 1;
    const hover = session.getHoverInfo('/fn.ts', position);
    expect(hover?.text).toContain('number');
  });
});

describe('LanguageServiceSession: go-to-definition', () => {
  let vfs: VirtualFileSystem;
  let session: LanguageServiceSession;

  beforeEach(() => {
    vfs = new VirtualFileSystem();
    session = new LanguageServiceSession(vfs);
  });

  it('jumps from a usage in one file to the declaration in another', () => {
    const libSource = 'export function greet(name: string): string {\n  return "hello " + name;\n}\n';
    vfs.writeFile('/greeter.ts', libSource);
    const mainSource = 'import { greet } from "./greeter";\ngreet("world");\n';
    vfs.writeFile('/app.ts', mainSource);

    const usagePosition = mainSource.lastIndexOf('greet(') + 1;
    const defs = session.getDefinition('/app.ts', usagePosition);
    expect(defs.length).toBeGreaterThan(0);
    expect(defs[0]?.path).toBe('/greeter.ts');
    const expectedStart = libSource.indexOf('greet');
    expect(defs[0]?.start).toBe(expectedStart);
  });

  it('jumps to a local variable declaration within the same file', () => {
    const source = 'const localValue = 42;\nconsole.log(localValue);\n';
    vfs.writeFile('/local.ts', source);
    const usagePosition = source.lastIndexOf('localValue') + 1;
    const defs = session.getDefinition('/local.ts', usagePosition);
    expect(defs.length).toBeGreaterThan(0);
    expect(defs[0]?.path).toBe('/local.ts');
    expect(defs[0]?.start).toBe(source.indexOf('localValue'));
  });
});

describe('LanguageServiceSession: formatting', () => {
  it('formats a document and writes the result back to the VFS', () => {
    const vfs = new VirtualFileSystem();
    const session = new LanguageServiceSession(vfs);
    vfs.writeFile('/messy.ts', 'const   x=1;\nconst y   =2;\n');
    const formatted = session.formatDocument('/messy.ts');
    expect(formatted).not.toBe('const   x=1;\nconst y   =2;\n');
    expect(vfs.readFile('/messy.ts')).toBe(formatted);
    // Formatting should at least normalize the obviously-wrong spacing around '='.
    expect(formatted).toContain('const x = 1;');
  });
});

describe('LanguageServiceSession: dispose', () => {
  it('stops reacting to VFS writes after dispose', () => {
    const vfs = new VirtualFileSystem();
    const session = new LanguageServiceSession(vfs);
    vfs.writeFile('/a.ts', 'const a: number = 1;\n');
    session.dispose();
    // Should not throw even though the watcher was removed.
    vfs.writeFile('/a.ts', 'const a: number = "x";\n');
    expect(() => session.getDiagnostics('/a.ts')).not.toThrow();
  });
});
