/**
 * A tree-walking interpreter for the toy language that can genuinely pause mid-execution.
 *
 * The key design idea: every statement and every expression is evaluated inside a JS generator
 * function, and each statement *yields once, right before it runs*, carrying its source line and
 * the current call-stack depth. Driving the interpreter is then just deciding how many times to
 * call `.next()` on that generator before stopping:
 *   - `run()` keeps calling `.next()` until a yielded line is a breakpoint (or the program ends).
 *   - `stepOver()` keeps calling `.next()` until the yielded frame depth is back to <= where we
 *     started (so it skips over anything a nested call does).
 *   - `stepIn()` calls `.next()` exactly once, so if the current statement is a call, the very
 *     next yield is the callee's first statement — a real "step into".
 * Function calls are themselves implemented via `yield*` delegation into the callee's statement
 * generator, so recursion naturally produces a real, growing call stack (each activation gets its
 * own `Scope`), and pausing inside a deeply recursive call works for free — no special-casing.
 *
 * This is intentionally not a bytecode VM or a CPS-transformed interpreter; it walks the AST
 * directly. That keeps it readable and auditable, at the cost of speed nobody needs for a debug
 * toy language.
 */

import type { BinaryOp, Expr, FunctionDecl, Program, Stmt } from './ast.js';

export type Value = number | boolean;

export class InterpreterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterpreterError';
  }
}

/** A lexical scope: its own variables plus an optional parent to fall back to on lookup. */
class Scope {
  private readonly vars = new Map<string, Value>();

  constructor(private readonly parent: Scope | null) {}

  declare(name: string, value: Value): void {
    this.vars.set(name, value);
  }

  get(name: string): Value {
    if (this.vars.has(name)) return this.vars.get(name)!;
    if (this.parent) return this.parent.get(name);
    throw new InterpreterError(`Undefined variable '${name}'`);
  }

  /** Assigns to the nearest enclosing scope that already declared `name` (walks up via `let`). */
  assign(name: string, value: Value): void {
    if (this.vars.has(name)) {
      this.vars.set(name, value);
      return;
    }
    if (this.parent) {
      this.parent.assign(name, value);
      return;
    }
    throw new InterpreterError(`Undefined variable '${name}'`);
  }

  /** Variables declared directly in this scope (not walking to parent) — one call frame's own. */
  ownEntries(): [string, Value][] {
    return [...this.vars.entries()];
  }
}

interface CallFrame {
  functionName: string;
  scope: Scope;
  line: number;
}

/** What a statement generator yields at each statement boundary, just before running it. */
interface PauseSignal {
  line: number;
  frameDepth: number;
}

/** How a block/statement generator communicates a `return` propagating up out of nested blocks. */
type ExecResult = { kind: 'normal' } | { kind: 'return'; value: Value | undefined };

function truthy(v: Value): boolean {
  return typeof v === 'boolean' ? v : v !== 0;
}

function asNumber(v: Value): number {
  if (typeof v !== 'number') throw new InterpreterError('Expected a number');
  return v;
}

function applyBinary(op: BinaryOp, left: Value, right: Value): Value {
  switch (op) {
    case '+':
      return asNumber(left) + asNumber(right);
    case '-':
      return asNumber(left) - asNumber(right);
    case '*':
      return asNumber(left) * asNumber(right);
    case '/':
      return asNumber(left) / asNumber(right);
    case '%':
      return asNumber(left) % asNumber(right);
    case '<':
      return asNumber(left) < asNumber(right);
    case '<=':
      return asNumber(left) <= asNumber(right);
    case '>':
      return asNumber(left) > asNumber(right);
    case '>=':
      return asNumber(left) >= asNumber(right);
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case '&&':
    case '||':
      // Short-circuit forms are handled directly in evalExpr (they must not always evaluate the
      // right-hand side); reaching here would be a parser/interpreter mismatch.
      throw new InterpreterError(`'${op}' must be short-circuited by the caller`);
  }
}

export function formatValue(v: Value): string {
  return String(v);
}

export type RunOutcome = 'paused' | 'done';

/**
 * `getCallStack()` / `getVariablesInScope()` index frames innermost-first (index 0 is the
 * currently executing frame), matching how a real DAP client renders a call stack top-down.
 */
export class Interpreter {
  private readonly functions = new Map<string, FunctionDecl>();
  private readonly globalScope = new Scope(null);
  private readonly callStack: CallFrame[] = [];
  private readonly breakpoints = new Set<number>();
  private readonly outputLines: string[] = [];

  private gen: Generator<PauseSignal, ExecResult, void> | null = null;
  private lastPause: PauseSignal | null = null;
  private finished = false;

  constructor(private readonly program: Program) {
    for (const fn of program.functions) {
      this.functions.set(fn.name, fn);
    }
    const globalFrame: CallFrame = { functionName: '<program>', scope: this.globalScope, line: 0 };
    this.callStack.push(globalFrame);
    this.gen = this.execBlock(program.statements, globalFrame);
  }

  setBreakpoint(line: number): void {
    this.breakpoints.add(line);
  }

  removeBreakpoint(line: number): void {
    this.breakpoints.delete(line);
  }

  isFinished(): boolean {
    return this.finished;
  }

  getOutput(): readonly string[] {
    return this.outputLines;
  }

  getCurrentLine(): number | null {
    return this.lastPause?.line ?? null;
  }

  getCallStack(): { functionName: string; line: number }[] {
    return [...this.callStack].reverse().map((f) => ({ functionName: f.functionName, line: f.line }));
  }

  /** `frameIndex` 0 = innermost (current) frame, matching `getCallStack()`'s ordering. */
  getVariablesInScope(frameIndex: number): { name: string; value: string; type: 'number' | 'boolean' }[] {
    const frame = [...this.callStack].reverse()[frameIndex];
    if (!frame) return [];
    return frame.scope.ownEntries().map(([name, value]) => ({
      name,
      value: formatValue(value),
      type: typeof value === 'boolean' ? 'boolean' : 'number',
    }));
  }

  /** Runs until a breakpoint line is about to execute, or the program finishes. */
  run(): RunOutcome {
    return this.drive(() => false);
  }

  /** Steps to the next statement boundary at the same or a shallower call-stack depth. */
  stepOver(): RunOutcome {
    const startDepth = this.lastPause?.frameDepth ?? this.callStack.length;
    return this.drive((sig) => sig.frameDepth <= startDepth);
  }

  /** Steps to the very next statement boundary, however deep (enters called functions). */
  stepIn(): RunOutcome {
    return this.drive(() => true, /* singleStep */ true);
  }

  /**
   * Shared driver: repeatedly resumes the generator. `shouldStop` is evaluated against every
   * yielded pause signal; a breakpoint line always stops regardless of `shouldStop`, matching
   * real debuggers (a breakpoint fires even mid step-over). `singleStep` stops unconditionally
   * after exactly one resume, used by `stepIn`.
   */
  private drive(shouldStop: (sig: PauseSignal) => boolean, singleStep = false): RunOutcome {
    if (this.finished || !this.gen) return 'done';

    for (;;) {
      const result = this.gen.next();
      if (result.done) {
        this.finished = true;
        this.lastPause = null;
        return 'done';
      }
      const sig = result.value;
      this.lastPause = sig;
      if (singleStep || this.breakpoints.has(sig.line) || shouldStop(sig)) {
        return 'paused';
      }
    }
  }

  private *evalExpr(expr: Expr, frame: CallFrame): Generator<PauseSignal, Value, void> {
    switch (expr.kind) {
      case 'number':
        return expr.value;
      case 'bool':
        return expr.value;
      case 'identifier':
        return frame.scope.get(expr.name);
      case 'unary': {
        const v = yield* this.evalExpr(expr.operand, frame);
        if (expr.op === '-') return -asNumber(v);
        return !truthy(v);
      }
      case 'binary': {
        if (expr.op === '&&') {
          const l = yield* this.evalExpr(expr.left, frame);
          if (!truthy(l)) return false;
          const r = yield* this.evalExpr(expr.right, frame);
          return truthy(r);
        }
        if (expr.op === '||') {
          const l = yield* this.evalExpr(expr.left, frame);
          if (truthy(l)) return true;
          const r = yield* this.evalExpr(expr.right, frame);
          return truthy(r);
        }
        const l = yield* this.evalExpr(expr.left, frame);
        const r = yield* this.evalExpr(expr.right, frame);
        return applyBinary(expr.op, l, r);
      }
      case 'call': {
        const fn = this.functions.get(expr.callee);
        if (!fn) throw new InterpreterError(`Undefined function '${expr.callee}'`);
        const args: Value[] = [];
        for (const argExpr of expr.args) {
          args.push(yield* this.evalExpr(argExpr, frame));
        }
        const calleeScope = new Scope(this.globalScope);
        fn.params.forEach((param, i) => {
          calleeScope.declare(param, args[i] ?? 0);
        });
        const calleeFrame: CallFrame = { functionName: fn.name, scope: calleeScope, line: fn.line };
        this.callStack.push(calleeFrame);
        const result = yield* this.execBlock(fn.body, calleeFrame);
        this.callStack.pop();
        return result.kind === 'return' ? (result.value ?? 0) : 0;
      }
    }
  }

  private *execStmt(stmt: Stmt, frame: CallFrame): Generator<PauseSignal, ExecResult, void> {
    frame.line = stmt.line;
    yield { line: stmt.line, frameDepth: this.callStack.length };

    switch (stmt.kind) {
      case 'let': {
        const v = yield* this.evalExpr(stmt.init, frame);
        frame.scope.declare(stmt.name, v);
        return { kind: 'normal' };
      }
      case 'assign': {
        const v = yield* this.evalExpr(stmt.value, frame);
        frame.scope.assign(stmt.name, v);
        return { kind: 'normal' };
      }
      case 'if': {
        const test = yield* this.evalExpr(stmt.test, frame);
        if (truthy(test)) return yield* this.execBlock(stmt.then, frame);
        if (stmt.else) return yield* this.execBlock(stmt.else, frame);
        return { kind: 'normal' };
      }
      case 'while': {
        while (truthy(yield* this.evalExpr(stmt.test, frame))) {
          const r = yield* this.execBlock(stmt.body, frame);
          if (r.kind === 'return') return r;
        }
        return { kind: 'normal' };
      }
      case 'print': {
        const v = yield* this.evalExpr(stmt.value, frame);
        this.outputLines.push(formatValue(v));
        return { kind: 'normal' };
      }
      case 'return': {
        const v = stmt.value ? yield* this.evalExpr(stmt.value, frame) : undefined;
        return { kind: 'return', value: v };
      }
      case 'exprStmt': {
        yield* this.evalExpr(stmt.expr, frame);
        return { kind: 'normal' };
      }
    }
  }

  private *execBlock(stmts: Stmt[], frame: CallFrame): Generator<PauseSignal, ExecResult, void> {
    for (const stmt of stmts) {
      const r = yield* this.execStmt(stmt, frame);
      if (r.kind === 'return') return r;
    }
    return { kind: 'normal' };
  }
}
