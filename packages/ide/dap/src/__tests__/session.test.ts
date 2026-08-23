import { describe, expect, it } from 'vitest';
import { DebugSession } from '../session.js';
import type {
  Event,
  Response,
  ScopesResponseBody,
  SetBreakpointsResponseBody,
  StackTraceResponseBody,
  StoppedEventBody,
  VariablesResponseBody,
} from '../protocol.js';

/**
 * The toy program under debug for the end-to-end DAP sequence test below. Line numbers matter —
 * they're referenced directly by the breakpoint and by assertions on `stopped` events.
 *
 *  1: let sum = 0;
 *  2: let i = 1;
 *  3: while (i <= 3) {
 *  4:   sum = sum + i;
 *  5:   i = i + 1;
 *  6: }
 *  7: print(sum);
 */
const PROGRAM = [
  'let sum = 0;',
  'let i = 1;',
  'while (i <= 3) {',
  '  sum = sum + i;',
  '  i = i + 1;',
  '}',
  'print(sum);',
].join('\n');

let nextClientSeq = 1;
function req(command: string, args?: unknown): { seq: number; type: 'request'; command: string; arguments?: unknown } {
  return { seq: nextClientSeq++, type: 'request', command, ...(args !== undefined ? { arguments: args } : {}) };
}

function isResponse(m: Response | Event): m is Response {
  return m.type === 'response';
}
function isEvent(m: Response | Event): m is Event {
  return m.type === 'event';
}

describe('DebugSession — full DAP request/response/event sequence', () => {
  it('drives initialize -> launch -> setBreakpoints -> continue -> inspect -> step -> continue', () => {
    const session = new DebugSession();
    const seenSeqs: number[] = [];

    const assertWellFormed = (messages: (Response | Event)[], requestSeq?: number): void => {
      for (const m of messages) {
        expect(seenSeqs).not.toContain(m.seq);
        seenSeqs.push(m.seq);
        if (isResponse(m) && requestSeq !== undefined) {
          expect(m.request_seq).toBe(requestSeq);
        }
      }
      // seq strictly increasing overall.
      for (let i = 1; i < seenSeqs.length; i += 1) {
        expect(seenSeqs[i]!).toBeGreaterThan(seenSeqs[i - 1]!);
      }
    };

    // 1. initialize
    const initRequest = req('initialize', { adapterID: 'toy-dap' });
    const initMsgs = session.handleRequest(initRequest);
    assertWellFormed(initMsgs, initRequest.seq);
    expect(initMsgs).toHaveLength(1);
    expect(initMsgs[0]).toMatchObject({ type: 'response', success: true, command: 'initialize' });

    // 2. launch — expect a Response followed by an `initialized` Event.
    const launchRequest = req('launch', { program: PROGRAM });
    const launchMsgs = session.handleRequest(launchRequest);
    assertWellFormed(launchMsgs, launchRequest.seq);
    expect(launchMsgs).toHaveLength(2);
    expect(launchMsgs[0]).toMatchObject({ type: 'response', success: true, command: 'launch' });
    expect(launchMsgs[1]).toMatchObject({ type: 'event', event: 'initialized' });

    // 3. setBreakpoints — breakpoint inside the loop body, on `sum = sum + i;` (line 4).
    const setBpRequest = req('setBreakpoints', { source: { path: 'program.toy' }, breakpoints: [{ line: 4 }] });
    const setBpMsgs = session.handleRequest(setBpRequest);
    assertWellFormed(setBpMsgs, setBpRequest.seq);
    expect(setBpMsgs).toHaveLength(1);
    const setBpResponse = setBpMsgs[0] as Response<SetBreakpointsResponseBody>;
    expect(setBpResponse.success).toBe(true);
    expect(setBpResponse.body?.breakpoints).toEqual([{ verified: true, line: 4 }]);

    // 4. continue — response first, then a `stopped` event with reason 'breakpoint' at line 4.
    const continueRequest = req('continue', { threadId: 1 });
    const continueMsgs = session.handleRequest(continueRequest);
    assertWellFormed(continueMsgs, continueRequest.seq);
    expect(continueMsgs[0]).toMatchObject({ type: 'response', success: true, command: 'continue' });
    const stoppedEvent = continueMsgs.find((m) => isEvent(m) && m.event === 'stopped') as Event<StoppedEventBody>;
    expect(stoppedEvent).toBeDefined();
    expect(stoppedEvent.body).toMatchObject({ reason: 'breakpoint', threadId: 1, line: 4 });

    // 5. stackTrace -> scopes -> variables, and the values must match what's actually live:
    //    first breakpoint hit is the first loop iteration, so sum=0, i=1.
    const stackTraceMsgs = session.handleRequest(req('stackTrace', { threadId: 1 }));
    const stackBody = (stackTraceMsgs[0] as Response<StackTraceResponseBody>).body!;
    expect(stackBody.stackFrames).toHaveLength(1);
    expect(stackBody.stackFrames[0]).toMatchObject({ name: '<program>', line: 4 });
    const frameId = stackBody.stackFrames[0]!.id;

    const scopesMsgs = session.handleRequest(req('scopes', { frameId }));
    const scopesBody = (scopesMsgs[0] as Response<ScopesResponseBody>).body!;
    expect(scopesBody.scopes).toHaveLength(1);
    const variablesReference = scopesBody.scopes[0]!.variablesReference;

    const variablesMsgs = session.handleRequest(req('variables', { variablesReference }));
    const variablesBody = (variablesMsgs[0] as Response<VariablesResponseBody>).body!;
    const byName = Object.fromEntries(variablesBody.variables.map((v) => [v.name, v.value]));
    expect(byName['sum']).toBe('0');
    expect(byName['i']).toBe('1');

    // 6. next (step over) — moves to the next statement (line 5) and fires `stopped` reason 'step'.
    const nextMsgs = session.handleRequest(req('next', { threadId: 1 }));
    expect(nextMsgs[0]).toMatchObject({ type: 'response', success: true, command: 'next' });
    const stepEvent = nextMsgs.find((m) => isEvent(m) && m.event === 'stopped') as Event<StoppedEventBody>;
    expect(stepEvent.body).toMatchObject({ reason: 'step', line: 5 });

    // 7. stepIn on a non-call statement behaves like a single step forward too (loop back to line 4
    //    via the closing brace / condition re-check happens across a couple of statement bounds).
    const stepInMsgs = session.handleRequest(req('stepIn', { threadId: 1 }));
    const stepInEvent = stepInMsgs.find((m) => isEvent(m) && m.event === 'stopped') as Event<StoppedEventBody>;
    expect(stepInEvent.body).toMatchObject({ reason: 'step' });

    // 8. continue again — the breakpoint at line 4 fires again on the next loop iteration.
    const continue2Msgs = session.handleRequest(req('continue', { threadId: 1 }));
    const stopped2 = continue2Msgs.find((m) => isEvent(m) && m.event === 'stopped') as Event<StoppedEventBody>;
    expect(stopped2.body).toMatchObject({ reason: 'breakpoint', line: 4 });
    const vars2Msgs = session.handleRequest(req('variables', { variablesReference }));
    const vars2Body = (vars2Msgs[0] as Response<VariablesResponseBody>).body!;
    const byName2 = Object.fromEntries(vars2Body.variables.map((v) => [v.name, v.value]));
    // stepIn (step 7) already advanced execution one statement further into the second loop
    // iteration before this second breakpoint hit, so `i` has already ticked past 2 to 3 here.
    expect(byName2['i']).toBe('3');

    // 9. continue through the remaining iterations until the program terminates.
    let terminatedSeen = false;
    for (let guard = 0; guard < 10 && !terminatedSeen; guard += 1) {
      const msgs = session.handleRequest(req('continue', { threadId: 1 }));
      if (msgs.some((m) => isEvent(m) && m.event === 'terminated')) {
        terminatedSeen = true;
      }
    }
    expect(terminatedSeen).toBe(true);
  });

  it('returns an error response when a command is sent before launch', () => {
    const session = new DebugSession();
    const [response] = session.handleRequest(req('continue', { threadId: 1 }));
    expect(response).toMatchObject({ type: 'response', success: false, command: 'continue' });
  });

  it('reports a failed launch response on invalid program source', () => {
    const session = new DebugSession();
    session.handleRequest(req('initialize', { adapterID: 'toy-dap' }));
    const [response] = session.handleRequest(req('launch', { program: 'let x = ;' }));
    expect(response).toMatchObject({ type: 'response', success: false, command: 'launch' });
  });

  it('emits output events for print() calls encountered while running', () => {
    const session = new DebugSession();
    session.handleRequest(req('initialize', { adapterID: 'toy-dap' }));
    session.handleRequest(req('launch', { program: 'print(1 + 1);' }));
    const msgs = session.handleRequest(req('continue', { threadId: 1 }));
    const outputEvent = msgs.find((m) => isEvent(m) && m.event === 'output') as Event<{ output: string }>;
    expect(outputEvent).toBeDefined();
    expect(outputEvent.body?.output.trim()).toBe('2');
    const terminatedEvent = msgs.find((m) => isEvent(m) && m.event === 'terminated');
    expect(terminatedEvent).toBeDefined();
  });

  it('terminate tears down the session and emits a terminated event', () => {
    const session = new DebugSession();
    session.handleRequest(req('initialize', { adapterID: 'toy-dap' }));
    session.handleRequest(req('launch', { program: 'print(1);' }));
    const msgs = session.handleRequest(req('terminate'));
    expect(msgs[0]).toMatchObject({ type: 'response', success: true, command: 'terminate' });
    expect(msgs.some((m) => isEvent(m) && m.event === 'terminated')).toBe(true);
  });
});
