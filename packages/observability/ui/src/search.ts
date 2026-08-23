import { parseQuery, QueryParseError } from '@titanforge/query-lang';

export type SearchValidation = { valid: true } | { valid: false; message: string; pos: number };

/**
 * Validates a search box query client-side, before it ever leaves the browser, using the exact
 * same `parseQuery` the server runs — so a malformed query gets an immediate, position-accurate
 * error instead of a round trip to `/api/query` just to find out the syntax was wrong.
 */
export function validateSearchQuery(source: string): SearchValidation {
  try {
    parseQuery(source);
    return { valid: true };
  } catch (err) {
    if (err instanceof QueryParseError) return { valid: false, message: err.message, pos: err.pos };
    return { valid: false, message: err instanceof Error ? err.message : String(err), pos: 0 };
  }
}

/** Builds the `/api/query?q=...` URL for a validated search query, against a given server base URL. */
export function buildQueryUrl(baseUrl: string, source: string): string {
  const url = new URL('/api/query', baseUrl);
  url.searchParams.set('q', source);
  return url.toString();
}
