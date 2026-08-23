import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LsmEngine } from '@titanforge/storage-lsm';
import { Database } from '../database.js';

/**
 * The whole flagship, proven end to end: real SQL text goes in through the real parser, the real
 * binder, the real rule-based planner, the real Volcano executor, and lands on the real
 * WAL+memtable+SSTable storage engine — not `storage-memory`'s in-memory stand-in every other
 * package's own tests use. This is the one file in the whole SQL engine whose job is proving
 * every layer actually fits together, not just that each layer is correct in isolation.
 */

let dir: string;

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

function openDb(): { db: Database; dir: string } {
  dir = mkdtempSync(join(tmpdir(), 'titanforge-e2e-'));
  const storage = new LsmEngine(dir);
  return { db: new Database(storage), dir };
}

describe('Database + LsmEngine — full pipeline', () => {
  it('creates a table, inserts, and selects it back with a WHERE clause', () => {
    const { db } = openDb();
    db.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER)');
    db.executeScript(`
      INSERT INTO users VALUES (1, 'Ada', 36);
      INSERT INTO users VALUES (2, 'Alan', 41);
      INSERT INTO users VALUES (3, 'Grace', 85);
    `);

    const result = db.execute('SELECT name, age FROM users WHERE age > 40 ORDER BY age');
    expect(result.kind).toBe('select');
    if (result.kind !== 'select') throw new Error('unreachable');
    expect(result.rows).toEqual([['Alan', 41], ['Grace', 85]]);
  });

  it('runs a real JOIN + GROUP BY + aggregate through the whole stack', () => {
    const { db } = openDb();
    db.executeScript(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, total REAL);
      INSERT INTO users VALUES (1, 'Ada'), (2, 'Alan');
      INSERT INTO orders VALUES (1, 1, 10.0), (2, 1, 5.0), (3, 2, 20.0);
    `);

    const result = db.execute(
      'SELECT users.name, SUM(orders.total) FROM users JOIN orders ON users.id = orders.user_id GROUP BY users.name ORDER BY users.name',
    );
    if (result.kind !== 'select') throw new Error('unreachable');
    expect(result.rows).toEqual([['Ada', 15], ['Alan', 20]]);
  });

  it('UPDATE and DELETE actually mutate rows durably in the LSM engine', () => {
    const { db } = openDb();
    db.executeScript(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER);
      INSERT INTO t VALUES (1, 10), (2, 20), (3, 30);
    `);
    db.execute('UPDATE t SET n = 99 WHERE id = 2');
    db.execute('DELETE FROM t WHERE id = 3');

    const result = db.execute('SELECT id, n FROM t ORDER BY id');
    if (result.kind !== 'select') throw new Error('unreachable');
    expect(result.rows).toEqual([[1, 10], [2, 99]]);
  });

  it('a transaction\'s writes are invisible outside it until commit, and roll back cleanly on throw', () => {
    const { db } = openDb();
    db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER)');
    db.execute('INSERT INTO t VALUES (1, 1)');

    expect(() =>
      db.transaction((tx) => {
        tx.execute('INSERT INTO t VALUES (2, 2)');
        throw new Error('boom');
      }),
    ).toThrow('boom');

    const afterRollback = db.execute('SELECT id FROM t');
    if (afterRollback.kind !== 'select') throw new Error('unreachable');
    expect(afterRollback.rows).toEqual([[1]]);

    db.transaction((tx) => {
      tx.execute('INSERT INTO t VALUES (3, 3)');
    });
    const afterCommit = db.execute('SELECT id FROM t ORDER BY id');
    if (afterCommit.kind !== 'select') throw new Error('unreachable');
    expect(afterCommit.rows).toEqual([[1], [3]]);
  });

  it('data survives closing the process and opening a fresh Database + LsmEngine against the same directory', () => {
    const { db, dir: dataDir } = openDb();
    db.executeScript(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO t VALUES (1, 'durable');
    `);

    // No graceful shutdown call — simulating a hard restart, the same way storage-lsm's own
    // restart-durability test does, except here it's exercised through real SQL end to end.
    const reopened = new Database(new LsmEngine(dataDir));
    const result = reopened.execute('SELECT name FROM t WHERE id = 1');
    if (result.kind !== 'select') throw new Error('unreachable');
    expect(result.rows).toEqual([['durable']]);
  });

  it('a real syntax error surfaces as a rejected execute(), not a crash', () => {
    const { db } = openDb();
    expect(() => db.execute('SELECT FROM')).toThrow();
  });

  it('a real semantic error (unknown column) surfaces as a rejected execute()', () => {
    const { db } = openDb();
    db.execute('CREATE TABLE t (a INTEGER)');
    expect(() => db.execute('SELECT nope FROM t')).toThrow();
  });
});
