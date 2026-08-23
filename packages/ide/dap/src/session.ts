/**
 * `DebugSession` is the DAP-speaking front end: it accepts `Request` objects and produces the
 * `Response`/`Event` messages a real DAP transport would frame and send over stdio/sockets. This
 * package doesn't implement that transport (no Content-Length framing, no stdio pump) — a real
 * adapter binary would sit `DebugSession` behind one, feeding it parsed `Request` objects and
 * writing out whatever this returns.
 *
 * API choice: `handleRequest` returns `(Response | Event)[]`, everything this single request
 * produced, *in emission order*. That's necessary because several commands emit more than one
 * message — `launch` emits its `Response` then an `initialized` `Event`; `continue`/`next`/
 * `stepIn` emit their `Response` immediately (acknowledging receipt) followed by a `stopped` or
 * `terminated` `Event` once the interpreter actually finishes running. An event-emitter/callback
 * style would work too, but a plain returned array keeps this a pure function of
 * (session state, request) → messages, which is much easier to unit test — no callback capturing.
 *
 * `seq` is a single outgoing counter shared by every Response and Event this session emits
 * (matching the real spec: `seq` numbers the whole outgoing stream, not per-message-type), and it
 * is strictly increasing across calls to `handleRequest`. Incoming request `seq` values are only
 * ever read back out as `request_seq` on the matching response — this session never mutates or
 * relies on their ordering.
 */

import { Interpreter, type RunOutcome } from './interpreter.js';
import { parse } from './parser.js';
import type {
  Breakpoint,
  ContinueResponseBody,
  Event,
  InitializeResponseBody,
  LaunchRequestArguments,
  OutputEventBody,
  Request,
  Response,
  Scope,
  ScopesArguments,
  ScopesResponseBody,
  SetBreakpointsArguments,
  SetBreakpointsResponseBody,
  StackFrame,
  StackTraceResponseBody,
  StoppedEventBody,
  StoppedReason,
  TerminatedEventBody,
  Variable,
  VariablesArguments,
  VariablesResponseBody,
} from './protocol.js';

const THREAD_ID = 1;

type OutMessage = Response | Event;

/**
 * `variablesReference` in real DAP is an opaque handle the client hands back verbatim to
 * `variables` requests; adapters are free to encode whatever they like into it. Here it directly
 * encodes the call-stack frame index (0 = innermost) since every frame has exactly one flat
 * "Locals" scope in this toy language — no separate closures/globals scopes to distinguish.
 * Reference `0` is reserved as "no variables" so real references start at 1.
 */
function variablesReferenceForFrame(frameIndex: number): number {
  return frameIndex + 1;
}

function frameIndexForVariablesReference(ref: number): number {
  return ref - 1;
}

export class DebugSession {
  private outSeq = 1;
  private interpreter: Interpreter | null = null;

  handleRequest(request: Request): OutMessage[] {
    const out: OutMessage[] = [];

    const respond = <B>(success: boolean, body?: B, message?: string): void => {
      const response: Response<B> = {
        seq: this.outSeq++,
        type: 'response',
        request_seq: request.seq,
        success,
        command: request.command,
        ...(message !== undefined ? { message } : {}),
        ...(body !== undefined ? { body } : {}),
      };
      out.push(response as Response);
    };

    const emit = <B>(event: string, body?: B): void => {
      const evt: Event<B> = {
        seq: this.outSeq++,
        type: 'event',
        event,
        ...(body !== undefined ? { body } : {}),
      };
      out.push(evt as Event);
    };

    switch (request.command) {
      case 'initialize': {
        const body: InitializeResponseBody = { supportsConfigurationDoneRequest: true };
        respond(true, body);
        return out;
      }

      case 'launch': {
        const args = request.arguments as LaunchRequestArguments;
        try {
          const program = parse(args.program);
          this.interpreter = new Interpreter(program);
          respond(true);
          emit('initialized');
        } catch (err) {
          respond(false, undefined, describeError(err));
        }
        return out;
      }

      case 'setBreakpoints': {
        const args = request.arguments as SetBreakpointsArguments;
        if (!this.interpreter) {
          respond(false, undefined, 'No active debug session (launch was not called)');
          return out;
        }
        const interpreter = this.interpreter;
        const breakpoints: Breakpoint[] = args.breakpoints.map((bp) => {
          interpreter.setBreakpoint(bp.line);
          return { verified: true, line: bp.line };
        });
        const body: SetBreakpointsResponseBody = { breakpoints };
        respond(true, body);
        return out;
      }

      case 'continue': {
        if (!this.requireInterpreter(respond)) return out;
        respond<ContinueResponseBody>(true, { allThreadsContinued: true });
        this.runInterpreterAndEmit(() => this.interpreter!.run(), 'breakpoint', emit);
        return out;
      }

      case 'next': {
        if (!this.requireInterpreter(respond)) return out;
        respond(true);
        this.runInterpreterAndEmit(() => this.interpreter!.stepOver(), 'step', emit);
        return out;
      }

      case 'stepIn': {
        if (!this.requireInterpreter(respond)) return out;
        respond(true);
        this.runInterpreterAndEmit(() => this.interpreter!.stepIn(), 'step', emit);
        return out;
      }

      case 'stackTrace': {
        if (!this.requireInterpreter(respond)) return out;
        const frames = this.interpreter!.getCallStack();
        const stackFrames: StackFrame[] = frames.map((f, i) => ({
          id: i,
          name: f.functionName,
          line: f.line,
        }));
        const body: StackTraceResponseBody = { stackFrames };
        respond(true, body);
        return out;
      }

      case 'scopes': {
        if (!this.requireInterpreter(respond)) return out;
        const args = request.arguments as ScopesArguments;
        const scope: Scope = { name: 'Locals', variablesReference: variablesReferenceForFrame(args.frameId) };
        const body: ScopesResponseBody = { scopes: [scope] };
        respond(true, body);
        return out;
      }

      case 'variables': {
        if (!this.requireInterpreter(respond)) return out;
        const args = request.arguments as VariablesArguments;
        const frameIndex = frameIndexForVariablesReference(args.variablesReference);
        const vars = this.interpreter!.getVariablesInScope(frameIndex);
        const variables: Variable[] = vars.map((v) => ({ name: v.name, value: v.value, type: v.type }));
        const body: VariablesResponseBody = { variables };
        respond(true, body);
        return out;
      }

      case 'terminate': {
        this.interpreter = null;
        respond(true);
        emit<TerminatedEventBody>('terminated', {});
        return out;
      }

      default: {
        respond(false, undefined, `Unsupported command '${request.command}'`);
        return out;
      }
    }
  }

  private requireInterpreter(respond: (success: boolean, body?: unknown, message?: string) => void): boolean {
    if (!this.interpreter) {
      respond(false, undefined, 'No active debug session (launch was not called)');
      return false;
    }
    return true;
  }

  /**
   * Runs the interpreter via `step` (one of run/stepOver/stepIn) and translates the outcome into
   * the right DAP event: a `stopped` event with `reason` if it paused (whether that pause was a
   * genuine breakpoint hit during `continue`, or the natural end of a single step), or a
   * `terminated` event if the program ran to completion. Any buffered `print()` output produced
   * during the run is flushed first as `output` events, in order, since that's what a real
   * adapter does with a debuggee's stdout.
   */
  private runInterpreterAndEmit(
    step: () => RunOutcome,
    reasonIfPaused: StoppedReason,
    emit: <B>(event: string, body?: B) => void,
  ): void {
    const interpreter = this.interpreter;
    if (!interpreter) return;

    const outputBefore = interpreter.getOutput().length;
    const outcome = step();
    const outputAfter = interpreter.getOutput();
    for (let i = outputBefore; i < outputAfter.length; i += 1) {
      emit<OutputEventBody>('output', { category: 'stdout', output: `${outputAfter[i]}\n` });
    }

    if (outcome === 'done') {
      emit<TerminatedEventBody>('terminated', {});
      return;
    }

    const line = interpreter.getCurrentLine();
    const body: StoppedEventBody = {
      reason: reasonIfPaused,
      threadId: THREAD_ID,
      ...(line !== null ? { line } : {}),
    };
    emit('stopped', body);
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
