/**
 * Public surface of `@titanforge/dap`.
 *
 * Scope note (see also the doc comments in `protocol.ts`, `interpreter.ts`, and `session.ts`):
 * this package implements the real DAP wire-protocol message shapes and sequencing rules for a
 * focused command subset (initialize, launch, setBreakpoints, continue, next, stepIn, stackTrace,
 * scopes, variables, terminate), wired to a genuine, from-scratch, steppable, breakpoint-capable
 * tree-walking interpreter for a tiny toy language written for this package. It does NOT
 * integrate with the real V8/Node Inspector Protocol — debugging actual TS/JS would require that
 * separately and is out of scope here. The point of this package is to prove the DAP plumbing
 * (sequencing, correlation, event ordering) works correctly end-to-end against a real, pausable
 * execution engine.
 */

export { DebugSession } from './session.js';

export { Interpreter, InterpreterError, formatValue } from './interpreter.js';
export type { RunOutcome, Value } from './interpreter.js';

export { tokenize, LexError, KEYWORDS } from './lexer.js';
export type { Token, Keyword, PunctText } from './lexer.js';

export { parse, ParseError } from './parser.js';
export type { Expr, Stmt, Program, FunctionDecl, BinaryOp } from './ast.js';

export type {
  ProtocolMessage,
  Request,
  Response,
  Event,
  InitializeRequestArguments,
  InitializeResponseBody,
  LaunchRequestArguments,
  SourceBreakpoint,
  DapSource,
  SetBreakpointsArguments,
  Breakpoint,
  SetBreakpointsResponseBody,
  ThreadedRequestArguments,
  ContinueResponseBody,
  StackTraceArguments,
  StackFrame,
  StackTraceResponseBody,
  ScopesArguments,
  Scope,
  ScopesResponseBody,
  VariablesArguments,
  Variable,
  VariablesResponseBody,
  StoppedReason,
  StoppedEventBody,
  OutputEventBody,
  TerminatedEventBody,
  DapEvent,
} from './protocol.js';
