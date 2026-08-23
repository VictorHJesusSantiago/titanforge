export class VfsError extends Error {
  constructor(
    message: string,
    public readonly code: 'ENOENT' | 'EEXIST' | 'ENOTDIR' | 'EISDIR' | 'ENOTEMPTY',
    public readonly path: string,
  ) {
    super(message);
    this.name = 'VfsError';
  }
}

export function notFound(path: string): VfsError {
  return new VfsError(`no such file or directory: ${path}`, 'ENOENT', path);
}

export function alreadyExists(path: string): VfsError {
  return new VfsError(`file or directory already exists: ${path}`, 'EEXIST', path);
}

export function notADirectory(path: string): VfsError {
  return new VfsError(`not a directory: ${path}`, 'ENOTDIR', path);
}

export function isADirectory(path: string): VfsError {
  return new VfsError(`is a directory: ${path}`, 'EISDIR', path);
}

export function notEmpty(path: string): VfsError {
  return new VfsError(`directory not empty: ${path}`, 'ENOTEMPTY', path);
}
