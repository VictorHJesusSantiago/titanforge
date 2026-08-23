import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';
import { extractLoader } from '../loader.js';

function loaderOf(source: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  const file = project.createSourceFile('/route.ts', source);
  return extractLoader(file);
}

describe('extractLoader', () => {
  it('returns null when there is no loader export', () => {
    expect(loaderOf('export default function Page() { return null; }')).toBeNull();
  });

  it('returns null for a non-exported loader (not a public data contract)', () => {
    expect(loaderOf('function loader() { return { id: "1" }; }')).toBeNull();
  });

  it('extracts a sync function-declaration loader', () => {
    const descriptor = loaderOf('export function loader(): { id: string } { return { id: "1" }; }');
    expect(descriptor).not.toBeNull();
    expect(descriptor!.shape).toEqual({ kind: 'object', properties: { id: { kind: 'string' } } });
  });

  it('extracts and unwraps an async function-declaration loader', () => {
    const descriptor = loaderOf(
      'export async function loader(): Promise<{ id: string; count: number }> { return { id: "1", count: 1 }; }',
    );
    expect(descriptor!.shape).toEqual({
      kind: 'object',
      properties: { id: { kind: 'string' }, count: { kind: 'number' } },
    });
    expect(descriptor!.returnTypeText).not.toContain('Promise');
  });

  it('extracts an exported const arrow-function loader', () => {
    const descriptor = loaderOf(
      'export const loader = async (): Promise<{ ok: boolean }> => ({ ok: true });',
    );
    expect(descriptor!.shape).toEqual({ kind: 'object', properties: { ok: { kind: 'boolean' } } });
  });

  it('extracts an exported const function-expression loader', () => {
    const descriptor = loaderOf('export const loader = function (): { n: number } { return { n: 1 }; };');
    expect(descriptor!.shape).toEqual({ kind: 'object', properties: { n: { kind: 'number' } } });
  });

  it('a loader accepting params is still extracted by return type', () => {
    const descriptor = loaderOf(
      'export function loader(params: { id: string }): { name: string } { return { name: params.id }; }',
    );
    expect(descriptor!.shape).toEqual({ kind: 'object', properties: { name: { kind: 'string' } } });
  });

  it('reflects a changed return shape (the core "type-safe end-to-end" evidence)', () => {
    const before = loaderOf('export function loader(): { title: string } { return { title: "a" }; }');
    const after = loaderOf(
      'export function loader(): { title: string; publishedAt: string } { return { title: "a", publishedAt: "b" }; }',
    );
    expect(before!.shape).not.toEqual(after!.shape);
    expect(after!.shape).toEqual({
      kind: 'object',
      properties: { title: { kind: 'string' }, publishedAt: { kind: 'string' } },
    });
  });
});
