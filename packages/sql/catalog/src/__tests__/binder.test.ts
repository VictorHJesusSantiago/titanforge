import { describe, it, expect, beforeEach } from 'vitest';
import { parseStatement } from '@titanforge/parser';
import { Catalog } from '../catalog.js';
import { Binder, BinderError } from '../binder.js';
import type { BoundSelect } from '../bound-ast.js';

let catalog: Catalog;
let binder: Binder;

beforeEach(() => {
  catalog = new Catalog();
  catalog.createTable(
    'users',
    [
      { name: 'id', type: 'INTEGER', primaryKey: true, notNull: false },
      { name: 'name', type: 'TEXT', primaryKey: false, notNull: true },
      { name: 'age', type: 'INTEGER', primaryKey: false, notNull: false },
    ],
    false,
  );
  catalog.createTable(
    'orders',
    [
      { name: 'id', type: 'INTEGER', primaryKey: true, notNull: false },
      { name: 'user_id', type: 'INTEGER', primaryKey: false, notNull: false },
      { name: 'total', type: 'REAL', primaryKey: false, notNull: false },
    ],
    false,
  );
  binder = new Binder(catalog);
});

function bindSelect(sql: string): BoundSelect {
  return binder.bind(parseStatement(sql)) as BoundSelect;
}

describe('binding CREATE TABLE / DROP TABLE', () => {
  it('binds CREATE TABLE and it actually registers in the catalog', () => {
    binder.bind(parseStatement('CREATE TABLE t (a INTEGER)'));
    expect(catalog.hasTable('t')).toBe(true);
  });

  it('binds DROP TABLE of an existing table', () => {
    expect(() => binder.bind(parseStatement('DROP TABLE users'))).not.toThrow();
  });

  it('DROP TABLE without IF EXISTS throws BinderError for a missing table', () => {
    expect(() => binder.bind(parseStatement('DROP TABLE nope'))).toThrow(BinderError);
  });
});

describe('binding INSERT', () => {
  it('resolves an implicit column list to the table\'s full column order', () => {
    const bound = binder.bind(parseStatement(`INSERT INTO users VALUES (1, 'Ada', 30)`));
    expect(bound).toMatchObject({ kind: 'insert' });
    if (bound.kind !== 'insert') throw new Error('unreachable');
    expect(bound.columns.map((c) => c.name)).toEqual(['id', 'name', 'age']);
  });

  it('rejects a value count that does not match the column count', () => {
    expect(() => binder.bind(parseStatement(`INSERT INTO users VALUES (1, 'Ada')`))).toThrow(BinderError);
  });

  it('rejects inserting a text literal into a numeric column', () => {
    expect(() => binder.bind(parseStatement(`INSERT INTO users (id, name) VALUES ('x', 'Ada')`))).toThrow(BinderError);
  });

  it('rejects an unknown column in an explicit column list', () => {
    expect(() => binder.bind(parseStatement(`INSERT INTO users (nope) VALUES (1)`))).toThrow(BinderError);
  });

  it('rejects INSERT into an unknown table', () => {
    expect(() => binder.bind(parseStatement(`INSERT INTO ghosts VALUES (1)`))).toThrow(BinderError);
  });
});

describe('binding UPDATE / DELETE', () => {
  it('resolves assignment target columns and the WHERE clause against the single table', () => {
    expect(() => binder.bind(parseStatement(`UPDATE users SET age = 31 WHERE id = 1`))).not.toThrow();
  });

  it('rejects assigning to an unknown column', () => {
    expect(() => binder.bind(parseStatement(`UPDATE users SET nope = 1`))).toThrow(BinderError);
  });

  it('binds DELETE with a WHERE clause referencing a real column', () => {
    expect(() => binder.bind(parseStatement(`DELETE FROM users WHERE age < 18`))).not.toThrow();
  });
});

describe('binding SELECT — column resolution', () => {
  it('expands SELECT * into every column of the FROM table, in order', () => {
    const bound = bindSelect('SELECT * FROM users');
    expect(bound.columns.map((c) => c.alias)).toEqual(['id', 'name', 'age']);
  });

  it('rejects SELECT * with no FROM clause', () => {
    expect(() => bindSelect('SELECT *')).toThrow(BinderError);
  });

  it('resolves an unqualified column unambiguously present in one source', () => {
    const bound = bindSelect('SELECT name FROM users');
    expect(bound.columns[0]?.expr).toMatchObject({ kind: 'column', source: 'users', name: 'name', type: 'TEXT' });
  });

  it('resolves a qualified column via an explicit alias', () => {
    const bound = bindSelect('SELECT u.name FROM users u');
    expect(bound.columns[0]?.expr).toMatchObject({ kind: 'column', source: 'u' });
  });

  it('rejects an unknown column', () => {
    expect(() => bindSelect('SELECT nope FROM users')).toThrow(BinderError);
  });

  it('rejects an ambiguous unqualified column present in two joined sources', () => {
    expect(() =>
      bindSelect('SELECT id FROM users JOIN orders ON users.id = orders.user_id'),
    ).toThrow(/ambiguous/);
  });

  it('rejects a duplicate table alias', () => {
    expect(() => bindSelect('SELECT * FROM users a JOIN orders a ON true')).toThrow(/duplicate/i);
  });

  it('infers a default alias from a bare column, and a lowercase one from a function call', () => {
    const bound = bindSelect('SELECT name, COUNT(*) FROM users');
    expect(bound.columns[0]?.alias).toBe('name');
    expect(bound.columns[1]?.alias).toBe('count');
  });

  it('an explicit AS alias always wins over the inferred one', () => {
    const bound = bindSelect('SELECT name AS n FROM users');
    expect(bound.columns[0]?.alias).toBe('n');
  });
});

describe('binding SELECT — joins', () => {
  it('binds an inner join condition against both sides', () => {
    const bound = bindSelect('SELECT * FROM users JOIN orders ON users.id = orders.user_id');
    expect(bound.joins).toHaveLength(1);
    expect(bound.joins[0]?.joinKind).toBe('inner');
    expect(bound.joins[0]?.on).toMatchObject({ kind: 'binary', op: '=' });
  });

  it('binds a left join', () => {
    const bound = bindSelect('SELECT * FROM users LEFT JOIN orders ON users.id = orders.user_id');
    expect(bound.joins[0]?.joinKind).toBe('left');
  });

  it('rejects a join against an unknown table', () => {
    expect(() => bindSelect('SELECT * FROM users JOIN ghosts ON true')).toThrow(BinderError);
  });
});

describe('binding SELECT — type inference and checking', () => {
  it('infers INTEGER + INTEGER as INTEGER, and INTEGER + REAL as REAL', () => {
    expect(bindSelect('SELECT age + 1 FROM users').columns[0]?.expr.type).toBe('INTEGER');
    expect(bindSelect('SELECT age + 1.5 FROM users').columns[0]?.expr.type).toBe('REAL');
  });

  it('infers a comparison as BOOLEAN', () => {
    expect(bindSelect('SELECT age > 18 FROM users').columns[0]?.expr.type).toBe('BOOLEAN');
  });

  it('rejects arithmetic on a non-numeric operand', () => {
    expect(() => bindSelect(`SELECT name + 1 FROM users`)).toThrow(BinderError);
  });

  it('rejects comparing incompatible types', () => {
    expect(() => bindSelect(`SELECT * FROM users WHERE name > 5`)).toThrow(BinderError);
  });

  it('allows comparing anything with NULL', () => {
    expect(() => bindSelect(`SELECT * FROM users WHERE name = NULL`)).not.toThrow();
  });

  it('rejects AND/OR on a non-boolean operand', () => {
    expect(() => bindSelect(`SELECT * FROM users WHERE age AND true`)).toThrow(BinderError);
  });
});

describe('binding SELECT — aggregates and GROUP BY', () => {
  it('detects hasAggregates from a top-level aggregate call', () => {
    expect(bindSelect('SELECT COUNT(*) FROM users').hasAggregates).toBe(true);
    expect(bindSelect('SELECT name FROM users').hasAggregates).toBe(false);
  });

  it('COUNT(*) binds with an empty args array and type INTEGER', () => {
    const bound = bindSelect('SELECT COUNT(*) FROM users');
    expect(bound.columns[0]?.expr).toMatchObject({ kind: 'call', name: 'COUNT', args: [], type: 'INTEGER', isAggregate: true });
  });

  it('SUM/AVG infer REAL; MIN/MAX infer the argument\'s own type', () => {
    expect(bindSelect('SELECT SUM(total) FROM orders').columns[0]?.expr.type).toBe('REAL');
    expect(bindSelect('SELECT AVG(total) FROM orders').columns[0]?.expr.type).toBe('REAL');
    expect(bindSelect('SELECT MIN(age) FROM users').columns[0]?.expr.type).toBe('INTEGER');
  });

  it('allows a non-aggregate column that IS a GROUP BY key', () => {
    expect(() => bindSelect('SELECT age, COUNT(*) FROM users GROUP BY age')).not.toThrow();
  });

  it('rejects a non-aggregate, non-grouped column in a grouped query', () => {
    expect(() => bindSelect('SELECT name, COUNT(*) FROM users GROUP BY age')).toThrow(/GROUP BY/);
  });

  it('a bare aggregate query (no GROUP BY at all) never triggers the grouped-column check', () => {
    expect(() => bindSelect('SELECT COUNT(*), SUM(age) FROM users')).not.toThrow();
  });
});

describe('binding SELECT — scalar functions', () => {
  it('binds UPPER/LOWER/LENGTH/ABS with their fixed return types', () => {
    expect(bindSelect(`SELECT UPPER(name) FROM users`).columns[0]?.expr.type).toBe('TEXT');
    expect(bindSelect(`SELECT LENGTH(name) FROM users`).columns[0]?.expr.type).toBe('INTEGER');
    expect(bindSelect(`SELECT ABS(age) FROM users`).columns[0]?.expr.type).toBe('INTEGER');
  });

  it('rejects a scalar function called with the wrong arity', () => {
    expect(() => bindSelect(`SELECT UPPER(name, name) FROM users`)).toThrow(BinderError);
  });

  it('rejects an unknown function name', () => {
    expect(() => bindSelect(`SELECT NOPE(name) FROM users`)).toThrow(/unknown function/);
  });

  it('COALESCE is variadic', () => {
    expect(() => bindSelect(`SELECT COALESCE(name, 'x', 'y') FROM users`)).not.toThrow();
  });
});
