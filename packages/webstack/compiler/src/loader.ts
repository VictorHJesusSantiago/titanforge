import { Node, type SourceFile, type Type } from 'ts-morph';
import type { LoaderDescriptor } from './manifest-types.js';
import { describeType } from './type-shape.js';

/**
 * Finds a route file's exported `loader`, whether declared as a function declaration
 * (`export async function loader() {...}`) or as an exported arrow/function-expression const
 * (`export const loader = async () => {...}`), and extracts a `LoaderDescriptor` from its real,
 * checker-derived return type — unwrapped from `Promise<T>` when the loader is async.
 *
 * Returns `null` when the route file has no exported `loader`.
 */
export function extractLoader(sourceFile: SourceFile): LoaderDescriptor | null {
  const returnType = findLoaderReturnType(sourceFile);
  if (!returnType) return null;

  const unwrapped = unwrapPromise(returnType);
  return {
    returnTypeText: unwrapped.getText(),
    shape: describeType(unwrapped),
  };
}

function findLoaderReturnType(sourceFile: SourceFile): Type | null {
  const fn = sourceFile.getFunction('loader');
  if (fn && fn.isExported()) {
    return fn.getReturnType();
  }

  const variable = sourceFile.getVariableDeclaration('loader');
  if (variable && variable.isExported()) {
    const initializer = variable.getInitializer();
    if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
      return initializer.getReturnType();
    }
  }

  return null;
}

function unwrapPromise(type: Type): Type {
  if (type.getSymbol()?.getName() === 'Promise') {
    const [inner] = type.getTypeArguments();
    if (inner) return inner;
  }
  return type;
}
