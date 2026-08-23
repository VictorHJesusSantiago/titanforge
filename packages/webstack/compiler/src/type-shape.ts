import type { Type } from 'ts-morph';

/**
 * A JSON-serializable structural summary of a TypeScript type, derived from the real TS type
 * checker (see `describeType`). This exists so tests can assert "the compiler's type analysis
 * produced X" without needing to compile and inspect `.d.ts` output — the shape *is* the
 * testable evidence that real type analysis happened, not a hand-maintained duplicate of it.
 */
export type TypeShape =
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'null' }
  | { kind: 'undefined' }
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'array'; element: TypeShape }
  | { kind: 'object'; properties: Record<string, TypeShape> }
  | { kind: 'union'; members: TypeShape[] }
  | { kind: 'unknown' };

const MAX_DEPTH = 8;

/**
 * Walks a `ts-morph`/TypeScript `Type` and produces a `TypeShape`. This is real type analysis:
 * it queries the type checker's view of the type (`isString`, `getProperties`,
 * `getArrayElementTypeOrThrow`, `getUnionTypes`, ...) rather than re-deriving anything from
 * source text. Recursion is depth-limited so that self-referential or very deep object graphs
 * degrade to `{ kind: 'unknown' }` instead of looping forever.
 */
export function describeType(type: Type, depth = 0): TypeShape {
  if (depth > MAX_DEPTH) return { kind: 'unknown' };

  if (type.isString()) return { kind: 'string' };
  if (type.isNumber()) return { kind: 'number' };
  if (type.isBoolean()) return { kind: 'boolean' };
  if (type.isNull()) return { kind: 'null' };
  if (type.isUndefined() || type.isVoid()) return { kind: 'undefined' };

  if (type.isStringLiteral() || type.isNumberLiteral() || type.isBooleanLiteral()) {
    const value = type.getLiteralValue();
    if (value !== undefined) return { kind: 'literal', value: value as string | number | boolean };
  }

  if (type.isArray()) {
    const element = type.getArrayElementTypeOrThrow();
    return { kind: 'array', element: describeType(element, depth + 1) };
  }

  if (type.isUnion()) {
    return { kind: 'union', members: type.getUnionTypes().map((member) => describeType(member, depth + 1)) };
  }

  if (type.isObject()) {
    const properties: Record<string, TypeShape> = {};
    for (const prop of type.getProperties()) {
      const decl = prop.getValueDeclaration() ?? prop.getDeclarations()[0];
      if (!decl) {
        properties[prop.getName()] = { kind: 'unknown' };
        continue;
      }
      const propType = prop.getTypeAtLocation(decl);
      properties[prop.getName()] = describeType(propType, depth + 1);
    }
    return { kind: 'object', properties };
  }

  return { kind: 'unknown' };
}
