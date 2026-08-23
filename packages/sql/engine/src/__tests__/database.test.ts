import { describe, it, expect } from 'vitest';
import { MemoryStorageEngine } from '@titanforge/storage-memory';
import { Database } from '../database.js';

function makeDb(): Database {
  return new Database(new MemoryStorageEngine());
}

describe('Database — DDL', () => {
  it('CREATE TABLE then SELECT sees the new (empty) table', () => {
    const db = makeDb();
    expect(db.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER)')).toEqual({ kind: 'ddl', ok: true });
    const result = db.execute('SELECT * FROM users');
    expect(result).toEqual({ kind: 'select', columns: ['id', 'name', 'age'], rows: [] });
  });

  it('CREATE TABLE IF NOT EXISTS is a no-op the second time, not an error', () => {
    const db = makeDb();
    db.execute('CREATE TABLE t (a INTEGER)');
    expect(() => db.execute('CREATE TABLE IF NOT EXISTS t (a INTEGER)')).not.toThrow();
  });

  it('DROP TABLE removes it from both the catalog and storage — re-creating it works', () => {
    const db = makeDb();
    db.execute('CREATE TABLE t (a INTEGER)');
    db.execute("INSERT INTO t VALUES (1)");
    expect(db.execute('DROP TABLE t')).toEqual({ kind: 'ddl', ok: true });
    expect(() => db.execute('SELECT * FROM t')).toThrow();
    expect(() => db.execute('CREATE TABLE t (a INTEGER)')).not.toThrow();
    expect(db.execute('SELECT * FROM t')).toEqual({ kind: 'select', columns: ['a'], rows: [] });
  });

  it('DROP TABLE IF EXISTS on a missing table does not throw', () => {
    const db = makeDb();
    expect(() => db.execute('DROP TABLE IF EXISTS nope')).not.toThrow();
  });
});

describe('Database — INSERT / SELECT', () => {
  it('inserts rows and reads them back', () => {
    const db = makeDb();
    db.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER)');
    const insertResult = db.execute("INSERT INTO users VALUES (1, 'Ada', 30)");
    expect(insertResult).toEqual({ kind: 'mutation', rowsAffected: 1 });

    const select = db.execute('SELECT id, name, age FROM users');
    expect(select).toEqual({ kind: 'select', columns: ['id', 'name', 'age'], rows: [[1, 'Ada', 30]] });
  });

  it('a partial column-list INSERT leaves unspecified columns NULL', () => {
    const db = makeDb();
    db.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)');
    db.execute("INSERT INTO users (id, name) VALUES (1, 'Ada')");
    const select = db.execute('SELECT id, name, age FROM users');
    expect(select).toEqual({ kind: 'select', columns: ['id', 'name', 'age'], rows: [[1, 'Ada', null]] });
  });

  it('multi-row VALUES inserts every row and reports the count', () => {
    const db = makeDb();
    db.execute('CREATE TABLE t (a INTEGER)');
    const result = db.execute('INSERT INTO t VALUES (1), (2), (3)');
    expect(result).toEqual({ kind: 'mutation', rowsAffected: 3 });
  });
});

describe('Database — SELECT with WHERE / JOIN / GROUP BY / ORDER BY / LIMIT', () => {
  function seeded(): Database {
    const db = makeDb();
    db.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER)');
    db.execute('CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, total REAL)');
    db.executeScript(`
      INSERT INTO users VALUES (1, 'Ada', 30);
      INSERT INTO users VALUES (2, 'Grace', 40);
      INSERT INTO orders VALUES (1, 1, 100);
      INSERT INTO orders VALUES (2, 1, 50);
      INSERT INTO orders VALUES (3, 2, 75);
    `);
    return db;
  }

  it('WHERE filters rows', () => {
    const db = seeded();
    const result = db.execute('SELECT name FROM users WHERE age > 35');
    expect(result).toEqual({ kind: 'select', columns: ['name'], rows: [['Grace']] });
  });

  it('JOIN combines matching rows across tables', () => {
    const db = seeded();
    const result = db.execute('SELECT u.name, o.total FROM users u JOIN orders o ON u.id = o.user_id ORDER BY o.total DESC');
    expect(result).toEqual({
      kind: 'select',
      columns: ['name', 'total'],
      rows: [
        ['Ada', 100],
        ['Grace', 75],
        ['Ada', 50],
      ],
    });
  });

  it('GROUP BY aggregates per group', () => {
    const db = seeded();
    const result = db.execute('SELECT user_id, SUM(total) AS total_spent FROM orders GROUP BY user_id ORDER BY user_id');
    expect(result).toEqual({
      kind: 'select',
      columns: ['user_id', 'total_spent'],
      rows: [
        [1, 150],
        [2, 75],
      ],
    });
  });

  it('ORDER BY + LIMIT combine correctly', () => {
    const db = seeded();
    const result = db.execute('SELECT id, total FROM orders ORDER BY total DESC LIMIT 2');
    expect(result).toEqual({ kind: 'select', columns: ['id', 'total'], rows: [[1, 100], [3, 75]] });
  });
});

describe('Database — UPDATE / DELETE', () => {
  function seeded(): Database {
    const db = makeDb();
    db.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER)');
    db.executeScript(`
      INSERT INTO users VALUES (1, 'Ada', 30);
      INSERT INTO users VALUES (2, 'Grace', 40);
      INSERT INTO users VALUES (3, 'Alan', 50);
    `);
    return db;
  }

  it('UPDATE with WHERE mutates only matching rows and reports the count', () => {
    const db = seeded();
    const result = db.execute('UPDATE users SET age = age + 1 WHERE age >= 40');
    expect(result).toEqual({ kind: 'mutation', rowsAffected: 2 });
    const rows = db.execute('SELECT name, age FROM users ORDER BY id');
    expect(rows).toEqual({ kind: 'select', columns: ['name', 'age'], rows: [['Ada', 30], ['Grace', 41], ['Alan', 51]] });
  });

  it('UPDATE with no WHERE mutates every row', () => {
    const db = seeded();
    const result = db.execute('UPDATE users SET age = 0');
    expect(result).toEqual({ kind: 'mutation', rowsAffected: 3 });
  });

  it('DELETE with WHERE removes only matching rows', () => {
    const db = seeded();
    const result = db.execute('DELETE FROM users WHERE age > 35');
    expect(result).toEqual({ kind: 'mutation', rowsAffected: 2 });
    const rows = db.execute('SELECT name FROM users');
    expect(rows).toEqual({ kind: 'select', columns: ['name'], rows: [['Ada']] });
  });
});

describe('Database — executeScript', () => {
  it('runs every `;`-separated statement and returns one QueryResult per statement', () => {
    const db = makeDb();
    const results = db.executeScript(`
      CREATE TABLE t (a INTEGER);
      INSERT INTO t VALUES (1);
      INSERT INTO t VALUES (2);
      SELECT a FROM t;
    `);
    expect(results).toHaveLength(4);
    expect(results[0]).toEqual({ kind: 'ddl', ok: true });
    expect(results[1]).toEqual({ kind: 'mutation', rowsAffected: 1 });
    expect(results[3]).toEqual({ kind: 'select', columns: ['a'], rows: [[1], [2]] });
  });
});

describe('Database — transaction()', () => {
  it("a transaction's writes are invisible to a separate autocommit read until it commits", () => {
    const db = makeDb();
    db.execute('CREATE TABLE t (a INTEGER)');

    let sawInsideBeforeCommit: unknown;
    db.transaction((tx) => {
      tx.execute('INSERT INTO t VALUES (1)');
      // A concurrent autocommit read (a fresh call to db.execute, outside the transaction) must
      // not see this uncommitted insert.
      sawInsideBeforeCommit = db.execute('SELECT a FROM t');
    });

    expect(sawInsideBeforeCommit).toEqual({ kind: 'select', columns: ['a'], rows: [] });
    // After commit, the row is visible.
    expect(db.execute('SELECT a FROM t')).toEqual({ kind: 'select', columns: ['a'], rows: [[1]] });
  });

  it('a transaction that throws is fully rolled back — none of its writes persist', () => {
    const db = makeDb();
    db.execute('CREATE TABLE t (a INTEGER)');

    expect(() =>
      db.transaction((tx) => {
        tx.execute('INSERT INTO t VALUES (1)');
        tx.execute('INSERT INTO t VALUES (2)');
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(db.execute('SELECT a FROM t')).toEqual({ kind: 'select', columns: ['a'], rows: [] });
  });

  it('a transaction that returns normally commits all of its writes atomically', () => {
    const db = makeDb();
    db.execute('CREATE TABLE t (a INTEGER)');

    const returned = db.transaction((tx) => {
      tx.execute('INSERT INTO t VALUES (1)');
      tx.execute('INSERT INTO t VALUES (2)');
      return 'ok';
    });

    expect(returned).toBe('ok');
    expect(db.execute('SELECT a FROM t')).toEqual({ kind: 'select', columns: ['a'], rows: [[1], [2]] });
  });
});
