/**
 * Debug Adapter Protocol (DAP) message shapes.
 *
 * These mirror the real, publicly documented Microsoft DAP wire format
 * (https://microsoft.github.io/debug-adapter-protocol/specification) closely enough that a real
 * DAP client (e.g. VS Code) would recognize the envelopes: every message carries a monotonically
 * increasing `seq`, requests are correlated to responses via `request_seq`, and out-of-band
 * notifications travel as `event` messages. What is intentionally NOT implemented is the full
 * command surface of the spec (there are dozens of commands) — only the subset named in scope:
 * initialize, launch, setBreakpoints, continue, next, stepIn, stackTrace, scopes, variables,
 * terminate, plus the initialized/stopped/terminated/output events. There is also no real
 * transport (no Content-Length-framed stdio/socket layer) — `DebugSession.handleRequest` takes
 * and returns plain JS objects, matching the shapes the wire protocol would carry.
 */

/** Every DAP message shares these two fields. */
export interface ProtocolMessage {
  seq: number;
  type: 'request' | 'response' | 'event';
}

export interface Request<A = unknown> extends ProtocolMessage {
  type: 'request';
  command: string;
  arguments?: A;
}

export interface Response<B = unknown> extends ProtocolMessage {
  type: 'response';
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: B;
}

export interface Event<B = unknown> extends ProtocolMessage {
  type: 'event';
  event: string;
  body?: B;
}

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

export interface InitializeRequestArguments {
  clientID?: string;
  adapterID: string;
}

export interface InitializeResponseBody {
  supportsConfigurationDoneRequest?: boolean;
}

// ---------------------------------------------------------------------------
// launch
// ---------------------------------------------------------------------------

/**
 * `program` is the toy-language source text directly rather than a file path — this package has
 * no filesystem dependency (it does not depend on @titanforge/vfs), so keeping `launch` fully
 * in-memory keeps the package self-contained.
 */
export interface LaunchRequestArguments {
  program: string;
}

// ---------------------------------------------------------------------------
// setBreakpoints
// ---------------------------------------------------------------------------

export interface SourceBreakpoint {
  line: number;
}

export interface DapSource {
  path: string;
}

export interface SetBreakpointsArguments {
  source: DapSource;
  breakpoints: SourceBreakpoint[];
}

export interface Breakpoint {
  verified: boolean;
  line: number;
}

export interface SetBreakpointsResponseBody {
  breakpoints: Breakpoint[];
}

// ---------------------------------------------------------------------------
// continue / next / stepIn — all take a threadId, none carry a meaningful body back beyond an
// optional flag, matching the real spec's minimal response bodies.
// ---------------------------------------------------------------------------

export interface ThreadedRequestArguments {
  threadId: number;
}

export interface ContinueResponseBody {
  allThreadsContinued?: boolean;
}

// ---------------------------------------------------------------------------
// stackTrace
// ---------------------------------------------------------------------------

export interface StackTraceArguments {
  threadId: number;
}

export interface StackFrame {
  id: number;
  name: string;
  line: number;
}

export interface StackTraceResponseBody {
  stackFrames: StackFrame[];
}

// ---------------------------------------------------------------------------
// scopes
// ---------------------------------------------------------------------------

export interface ScopesArguments {
  frameId: number;
}

export interface Scope {
  name: string;
  variablesReference: number;
}

export interface ScopesResponseBody {
  scopes: Scope[];
}

// ---------------------------------------------------------------------------
// variables
// ---------------------------------------------------------------------------

export interface VariablesArguments {
  variablesReference: number;
}

export interface Variable {
  name: string;
  value: string;
  type?: string;
}

export interface VariablesResponseBody {
  variables: Variable[];
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type StoppedReason = 'breakpoint' | 'step' | 'entry';

export interface StoppedEventBody {
  reason: StoppedReason;
  threadId: number;
  line?: number;
}

export interface OutputEventBody {
  category: string;
  output: string;
}

export interface TerminatedEventBody {
  restart?: boolean;
}

/** Convenience union of every event body this adapter emits, keyed by `event` name. */
export type DapEvent =
  | Event<undefined> // 'initialized'
  | Event<StoppedEventBody> // 'stopped'
  | Event<TerminatedEventBody> // 'terminated'
  | Event<OutputEventBody>; // 'output'
