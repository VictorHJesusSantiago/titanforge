/**
 * Command-line tokenizer/parser for the shell.
 *
 * Scope note: this parser supports words, single/double quoting, and pipes (`|`). Basic output
 * redirection (`>` / `>>`) is implemented as a nice-to-have since it was cheap to add once the
 * tokenizer exists — a `Command` node may carry an optional `redirect` target. Anything beyond
 * that (subshells, `&&`/`||` control flow, env var expansion, globbing) is out of scope: this is
 * a scoped command-line parser for a VFS-backed shell, not a POSIX shell reimplementation.
 */

/** A single parsed command: a name plus its argument words. */
export interface Command {
  name: string;
  args: string[];
  /** Optional `> file` / `>> file` redirection target for this command's stdout. */
  redirect?: { path: string; append: boolean };
}

/** A pipeline of one or more commands, connected left-to-right by `|`. */
export interface Pipeline {
  commands: Command[];
}

class ParseError extends Error {}

/** Tokenize a raw command line into words, honoring single/double quotes (quoted spaces stay
 *  part of the same token) and treating `|`, `>`, `>>` as standalone punctuation tokens. */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let hasCurrent = false;
  let i = 0;

  const flush = (): void => {
    if (hasCurrent) {
      tokens.push(current);
      current = '';
      hasCurrent = false;
    }
  };

  while (i < line.length) {
    const ch = line[i] as string;

    if (ch === ' ' || ch === '\t' || ch === '\n') {
      flush();
      i++;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      hasCurrent = true; // an empty quoted string ('') still yields a token
      while (i < line.length && line[i] !== quote) {
        current += line[i];
        i++;
      }
      if (i >= line.length) {
        throw new ParseError(`unterminated ${quote === '"' ? 'double' : 'single'} quote`);
      }
      i++; // consume closing quote
      continue;
    }

    if (ch === '|') {
      flush();
      tokens.push('|');
      i++;
      continue;
    }

    if (ch === '>') {
      flush();
      if (line[i + 1] === '>') {
        tokens.push('>>');
        i += 2;
      } else {
        tokens.push('>');
        i++;
      }
      continue;
    }

    current += ch;
    hasCurrent = true;
    i++;
  }
  flush();

  return tokens;
}

/** Parse a raw command line into a Pipeline AST. Returns an empty pipeline (no commands) for
 *  blank/whitespace-only input. Throws ParseError on malformed input (unterminated quote,
 *  dangling pipe, missing redirect target, etc). */
export function parse(line: string): Pipeline {
  const tokens = tokenize(line);
  if (tokens.length === 0) {
    return { commands: [] };
  }

  const commands: Command[] = [];
  let words: string[] = [];
  let redirect: Command['redirect'];

  const closeCommand = (): void => {
    if (words.length === 0) {
      throw new ParseError('expected a command');
    }
    const [name, ...args] = words;
    const command: Command = { name: name as string, args };
    if (redirect) command.redirect = redirect;
    commands.push(command);
    words = [];
    redirect = undefined;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    if (token === '|') {
      closeCommand();
      continue;
    }
    if (token === '>' || token === '>>') {
      const target = tokens[i + 1];
      if (target === undefined || target === '|' || target === '>' || target === '>>') {
        throw new ParseError('expected a file after redirection operator');
      }
      redirect = { path: target, append: token === '>>' };
      i++;
      continue;
    }
    words.push(token);
  }
  closeCommand();

  return { commands };
}

export { ParseError };
