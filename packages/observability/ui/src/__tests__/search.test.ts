import { describe, expect, it } from 'vitest';
import { validateSearchQuery, buildQueryUrl } from '../search.js';

describe('validateSearchQuery', () => {
  it('accepts a well-formed query', () => {
    expect(validateSearchQuery('service = "api" AND duration > 100')).toEqual({ valid: true });
  });

  it('rejects a malformed query with a position-accurate error', () => {
    const result = validateSearchQuery('bogus = 1');
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('unreachable');
    expect(result.pos).toBe(0);
    expect(result.message).toMatch(/unknown field/);
  });
});

describe('buildQueryUrl', () => {
  it('URL-encodes the query into the q parameter', () => {
    const url = buildQueryUrl('http://localhost:4318', 'service = "api"');
    expect(url).toBe('http://localhost:4318/api/query?q=service+%3D+%22api%22');
  });
});
