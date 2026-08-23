import { describe, it, expect } from 'vitest';
import { transformSource, loaderForPath } from '../transform.js';

describe('loaderForPath', () => {
  it('maps .tsx to tsx', () => expect(loaderForPath('a/b.tsx')).toBe('tsx'));
  it('maps .ts to ts', () => expect(loaderForPath('a/b.ts')).toBe('ts'));
  it('maps .jsx to jsx', () => expect(loaderForPath('a/b.jsx')).toBe('jsx'));
  it('defaults unknown extensions to js', () => expect(loaderForPath('a/b.mjs')).toBe('js'));
});

describe('transformSource', () => {
  it('strips TypeScript type annotations', async () => {
    const { code } = await transformSource('route.ts', 'const x: number = 1; export default x;');
    expect(code).not.toContain(': number');
    expect(code).toContain('const x = 1');
  });

  it('lowers a TSX file to plain JS', async () => {
    const { code } = await transformSource(
      'route.tsx',
      'export function Page(): string { const n: number = 1; return String(n); }',
    );
    expect(code).not.toContain(': number');
    expect(code).not.toContain(': string');
  });

  it('rejects genuinely invalid syntax', async () => {
    await expect(transformSource('route.ts', 'const x = ;;;')).rejects.toBeTruthy();
  });

  it('preserves runtime behavior across the transform (an interface disappears, logic remains)', async () => {
    const { code } = await transformSource(
      'route.ts',
      'interface Foo { id: string }\nexport function make(id: string): Foo { return { id }; }',
    );
    expect(code).not.toContain('interface');
    expect(code).toContain('function make');
  });
});
