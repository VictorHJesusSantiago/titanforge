#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { Database } from '@titanforge/engine';
import { MemoryStorageEngine } from '@titanforge/storage-memory';
import { formatError, formatQueryResult } from './format.js';

const EXIT_COMMANDS = new Set(['.exit', '.quit']);

function runScriptFile(db: Database, path: string): void {
  const sql = readFileSync(path, 'utf8');
  try {
    for (const result of db.executeScript(sql)) {
      process.stdout.write(formatQueryResult(result) + '\n');
    }
  } catch (error) {
    process.stderr.write(formatError(error) + '\n');
    process.exitCode = 1;
  }
}

function runRepl(db: Database): void {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'sql> ' });
  let buffer = '';

  rl.prompt();
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (buffer.length === 0 && EXIT_COMMANDS.has(trimmed)) {
      rl.close();
      return;
    }

    buffer += (buffer.length > 0 ? '\n' : '') + line;
    const semicolonIndex = buffer.indexOf(';');
    if (semicolonIndex !== -1) {
      const statementText = buffer.slice(0, semicolonIndex + 1);
      buffer = buffer.slice(semicolonIndex + 1);
      try {
        const result = db.execute(statementText);
        process.stdout.write(formatQueryResult(result) + '\n');
      } catch (error) {
        process.stdout.write(formatError(error) + '\n');
      }
    }
    rl.prompt();
  });

  rl.on('close', () => {
    process.stdout.write('\n');
    process.exit(0);
  });
}

function main(): void {
  const args = process.argv.slice(2);
  const fileFlagIndex = args.indexOf('-f');
  const db = new Database(new MemoryStorageEngine());

  if (fileFlagIndex !== -1) {
    const path = args[fileFlagIndex + 1];
    if (path === undefined) {
      process.stderr.write('Error: -f requires a file path argument\n');
      process.exitCode = 1;
      return;
    }
    runScriptFile(db, path);
    return;
  }

  runRepl(db);
}

main();
