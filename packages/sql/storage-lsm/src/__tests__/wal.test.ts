import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseWalLines, readWalFile, Wal, type WalRecord } from '../wal.js';

let dir: string;

beforeEach(() => {
  dir = path.join(os.tmpdir(), `titanforge-wal-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseWalLines (pure)', () => {
  it('parses zero records from an empty string', () => {
    expect(parseWalLines('')).toEqual([]);
  });

  it('parses multiple newline-delimited records in order', () => {
    const records: WalRecord[] = [
      { type: 'createTable', table: 't' },
      { type: 'write', table: 't', op: 'insert', id: '1', values: [1, 'a'], txn: 1 },
      { type: 'commit', txn: 1, ts: 1 },
    ];
    const content = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    expect(parseWalLines(content)).toEqual(records);
  });

  it('tolerates a torn (corrupt) final line, treating it as a crash mid-write', () => {
    const good: WalRecord = { type: 'createTable', table: 't' };
    const content = `${JSON.stringify(good)}\n{"type":"write","table":"t","id":"1"`; // truncated last line, no trailing newline
    expect(parseWalLines(content)).toEqual([good]);
  });

  it('rethrows a parse error that is not on the final line', () => {
    const good: WalRecord = { type: 'createTable', table: 't' };
    const content = `not json at all\n${JSON.stringify(good)}\n`;
    expect(() => parseWalLines(content)).toThrow();
  });

  it('ignores blank lines', () => {
    const good: WalRecord = { type: 'createTable', table: 't' };
    const content = `\n${JSON.stringify(good)}\n\n`;
    expect(parseWalLines(content)).toEqual([good]);
  });
});

describe('readWalFile (thin I/O)', () => {
  it('returns an empty string for a WAL file that does not exist yet', () => {
    expect(readWalFile(path.join(dir, 'nope.log'))).toBe('');
  });

  it('returns exactly what was written', () => {
    const p = path.join(dir, 'wal.log');
    fs.writeFileSync(p, 'hello\n');
    expect(readWalFile(p)).toBe('hello\n');
  });
});

describe('Wal class', () => {
  it('append then readAll (via a fresh Wal instance) round-trips records in order', () => {
    const p = path.join(dir, 'wal.log');
    const wal = new Wal(p);
    wal.append({ type: 'createTable', table: 't' });
    wal.append({ type: 'write', table: 't', op: 'insert', id: '1', values: [42], txn: 1 });
    wal.append({ type: 'commit', txn: 1, ts: 1 });
    wal.close();

    const reopened = new Wal(p);
    expect(reopened.readAll()).toEqual([
      { type: 'createTable', table: 't' },
      { type: 'write', table: 't', op: 'insert', id: '1', values: [42], txn: 1 },
      { type: 'commit', txn: 1, ts: 1 },
    ]);
    reopened.close();
  });

  it('appends persist on disk even without calling close() (fsync durability, no graceful shutdown)', () => {
    const p = path.join(dir, 'wal.log');
    const wal = new Wal(p);
    wal.append({ type: 'createTable', table: 't' });
    wal.append({ type: 'write', table: 't', op: 'insert', id: '1', values: ['x'], txn: 1 });
    wal.append({ type: 'commit', txn: 1, ts: 1 });
    // Deliberately do NOT call wal.close() — simulating a crash right after the last fsync'd append.

    const content = readWalFile(p);
    expect(parseWalLines(content)).toHaveLength(3);
  });

  it('a fresh Wal instance opens against an empty/nonexistent file with no records', () => {
    const wal = new Wal(path.join(dir, 'brand-new.log'));
    expect(wal.readAll()).toEqual([]);
    wal.close();
  });
});
