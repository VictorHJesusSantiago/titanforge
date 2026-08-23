import { describe, it, expect } from 'vitest';
import {
  ancestorDirs,
  buildRoutePath,
  dirnamePosix,
  isIgnoredBasename,
  isLayoutBasename,
  paramsFromSegments,
  parseSegment,
  stripRouteExtension,
} from '../segments.js';

describe('stripRouteExtension', () => {
  it('strips .tsx', () => {
    expect(stripRouteExtension('index.tsx')).toBe('index');
  });

  it('strips .ts', () => {
    expect(stripRouteExtension('loader.ts')).toBe('loader');
  });

  it('leaves unrecognized extensions alone', () => {
    expect(stripRouteExtension('data.json')).toBe('data.json');
  });
});

describe('isLayoutBasename / isIgnoredBasename', () => {
  it('recognizes _layout as a layout', () => {
    expect(isLayoutBasename('_layout')).toBe(true);
    expect(isIgnoredBasename('_layout')).toBe(false);
  });

  it('ignores other underscore-prefixed files', () => {
    expect(isIgnoredBasename('_helpers')).toBe(true);
    expect(isLayoutBasename('_helpers')).toBe(false);
  });

  it('treats normal names as neither', () => {
    expect(isLayoutBasename('index')).toBe(false);
    expect(isIgnoredBasename('index')).toBe(false);
  });
});

describe('parseSegment', () => {
  it('parses a static segment', () => {
    expect(parseSegment('users')).toEqual({ kind: 'static', value: 'users' });
  });

  it('parses a dynamic segment', () => {
    expect(parseSegment('[id]')).toEqual({ kind: 'dynamic', param: 'id' });
  });

  it('parses a catch-all segment', () => {
    expect(parseSegment('[...slug]')).toEqual({ kind: 'catchall', param: 'slug' });
  });
});

describe('buildRoutePath', () => {
  it('maps root index.tsx to /', () => {
    expect(buildRoutePath('index.tsx')).toEqual({ routePath: '/', segments: [] });
  });

  it('maps a static nested route', () => {
    expect(buildRoutePath('users/index.tsx')).toEqual({
      routePath: '/users',
      segments: [{ kind: 'static', value: 'users' }],
    });
  });

  it('maps a dynamic route file', () => {
    expect(buildRoutePath('users/[id].tsx')).toEqual({
      routePath: '/users/[id]',
      segments: [
        { kind: 'static', value: 'users' },
        { kind: 'dynamic', param: 'id' },
      ],
    });
  });

  it('maps a catch-all route file', () => {
    expect(buildRoutePath('blog/[...slug].tsx')).toEqual({
      routePath: '/blog/[...slug]',
      segments: [
        { kind: 'static', value: 'blog' },
        { kind: 'catchall', param: 'slug' },
      ],
    });
  });

  it('handles a plain top-level static file', () => {
    expect(buildRoutePath('about.tsx')).toEqual({
      routePath: '/about',
      segments: [{ kind: 'static', value: 'about' }],
    });
  });

  it('handles multiple dynamic segments', () => {
    expect(buildRoutePath('teams/[teamId]/members/[memberId].tsx')).toEqual({
      routePath: '/teams/[teamId]/members/[memberId]',
      segments: [
        { kind: 'static', value: 'teams' },
        { kind: 'dynamic', param: 'teamId' },
        { kind: 'static', value: 'members' },
        { kind: 'dynamic', param: 'memberId' },
      ],
    });
  });
});

describe('paramsFromSegments', () => {
  it('is empty for all-static segments', () => {
    expect(paramsFromSegments([{ kind: 'static', value: 'users' }])).toEqual([]);
  });

  it('extracts dynamic and catchall params in order', () => {
    expect(
      paramsFromSegments([
        { kind: 'static', value: 'teams' },
        { kind: 'dynamic', param: 'teamId' },
        { kind: 'catchall', param: 'rest' },
      ]),
    ).toEqual([
      { name: 'teamId', kind: 'dynamic' },
      { name: 'rest', kind: 'catchall' },
    ]);
  });
});

describe('dirnamePosix', () => {
  it('returns "" for a top-level file', () => {
    expect(dirnamePosix('index.tsx')).toBe('');
  });

  it('returns the parent dir for a nested file', () => {
    expect(dirnamePosix('users/[id].tsx')).toBe('users');
  });

  it('returns the full parent chain for a deeply nested file', () => {
    expect(dirnamePosix('a/b/c/d.tsx')).toBe('a/b/c');
  });
});

describe('ancestorDirs', () => {
  it('returns just root for the root dir', () => {
    expect(ancestorDirs('')).toEqual(['']);
  });

  it('returns root then each nested ancestor for a nested dir', () => {
    expect(ancestorDirs('a/b/c')).toEqual(['', 'a', 'a/b', 'a/b/c']);
  });
});
