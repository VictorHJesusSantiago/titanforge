import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';
import { describeType } from '../type-shape.js';

function shapeOfReturn(source: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  const file = project.createSourceFile('/loader.ts', source);
  const fn = file.getFunctionOrThrow('loader');
  return describeType(fn.getReturnType());
}

function shapeOfAsyncReturn(source: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  const file = project.createSourceFile('/loader.ts', source);
  const fn = file.getFunctionOrThrow('loader');
  const returnType = fn.getReturnType();
  const [inner] = returnType.getTypeArguments();
  return describeType(inner!);
}

describe('describeType — primitives', () => {
  it('describes string', () => {
    expect(shapeOfReturn('function loader(): string { return ""; }')).toEqual({ kind: 'string' });
  });

  it('describes number', () => {
    expect(shapeOfReturn('function loader(): number { return 0; }')).toEqual({ kind: 'number' });
  });

  it('describes boolean', () => {
    expect(shapeOfReturn('function loader(): boolean { return true; }')).toEqual({ kind: 'boolean' });
  });

  it('describes null', () => {
    expect(shapeOfReturn('function loader(): null { return null; }')).toEqual({ kind: 'null' });
  });

  it('describes undefined', () => {
    expect(shapeOfReturn('function loader(): undefined { return undefined; }')).toEqual({ kind: 'undefined' });
  });
});

describe('describeType — literals', () => {
  it('describes a string literal', () => {
    expect(shapeOfReturn('function loader(): "ok" { return "ok"; }')).toEqual({ kind: 'literal', value: 'ok' });
  });

  it('describes a number literal', () => {
    expect(shapeOfReturn('function loader(): 42 { return 42; }')).toEqual({ kind: 'literal', value: 42 });
  });
});

describe('describeType — arrays', () => {
  it('describes an array of strings', () => {
    expect(shapeOfReturn('function loader(): string[] { return []; }')).toEqual({
      kind: 'array',
      element: { kind: 'string' },
    });
  });

  it('describes an array of objects', () => {
    expect(shapeOfReturn('function loader(): { id: string }[] { return []; }')).toEqual({
      kind: 'array',
      element: { kind: 'object', properties: { id: { kind: 'string' } } },
    });
  });
});

describe('describeType — unions', () => {
  it('describes a string literal union', () => {
    expect(shapeOfReturn('function loader(): "ok" | "err" { return "ok"; }')).toEqual({
      kind: 'union',
      members: [
        { kind: 'literal', value: 'ok' },
        { kind: 'literal', value: 'err' },
      ],
    });
  });

  it('does not treat the primitive boolean type as a union of literals', () => {
    expect(shapeOfReturn('function loader(): boolean { return true; }')).toEqual({ kind: 'boolean' });
  });
});

describe('describeType — objects', () => {
  it('describes a flat object', () => {
    expect(shapeOfReturn('function loader(): { id: string; count: number } { return {} as never; }')).toEqual({
      kind: 'object',
      properties: { id: { kind: 'string' }, count: { kind: 'number' } },
    });
  });

  it('describes a nested object', () => {
    expect(
      shapeOfReturn('function loader(): { user: { id: string; active: boolean } } { return {} as never; }'),
    ).toEqual({
      kind: 'object',
      properties: {
        user: { kind: 'object', properties: { id: { kind: 'string' }, active: { kind: 'boolean' } } },
      },
    });
  });

  it('unwraps Promise<T> when the loader is async', () => {
    expect(
      shapeOfAsyncReturn('async function loader(): Promise<{ id: string; tags: string[] }> { return {} as never; }'),
    ).toEqual({
      kind: 'object',
      properties: { id: { kind: 'string' }, tags: { kind: 'array', element: { kind: 'string' } } },
    });
  });

  it('two structurally different loader shapes produce two different summaries', () => {
    const a = shapeOfReturn('function loader(): { id: string } { return {} as never; }');
    const b = shapeOfReturn('function loader(): { id: string; name: string } { return {} as never; }');
    expect(a).not.toEqual(b);
  });
});
