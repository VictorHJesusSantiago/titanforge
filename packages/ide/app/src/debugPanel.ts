import { DebugSession } from '@titanforge/dap';
import type { Request, StoppedEventBody, StackTraceResponseBody, VariablesResponseBody } from '@titanforge/dap';

/**
 * Wires the debug panel DOM (buttons, call stack list, variables list) to a real @titanforge/dap
 * `DebugSession`, itself backed by the real toy-language interpreter. This sends a genuine
 * sequence of DAP requests (initialize -> launch -> setBreakpoints -> continue/next/stepIn) and
 * renders whatever the session's responses/events report — the same plumbing packages/ide/dap's
 * own tests exercise, just driven from real button clicks instead of a scripted test sequence.
 * DOM-assembly glue, not unit-tested (see packages/ide/dap for the tested protocol/interpreter
 * logic this delegates to).
 */
export function mountDebugPanel(root: HTMLElement, program: string, breakpointLines: number[]): void {
  const stackEl = root.querySelector<HTMLDivElement>('#debug-stack');
  const varsEl = root.querySelector<HTMLDivElement>('#debug-variables');
  const runBtn = root.querySelector<HTMLButtonElement>('#debug-run');
  const continueBtn = root.querySelector<HTMLButtonElement>('#debug-continue');
  const stepOverBtn = root.querySelector<HTMLButtonElement>('#debug-step-over');
  const stepInBtn = root.querySelector<HTMLButtonElement>('#debug-step-in');
  if (!stackEl || !varsEl || !runBtn || !continueBtn || !stepOverBtn || !stepInBtn) {
    throw new Error('debug panel DOM structure missing expected elements');
  }
  // Re-bind to fresh consts: TS's null-narrowing above does not survive into the nested closures
  // declared below (they could, in principle, run after further reassignment), but these are
  // `const` bindings assigned from an already-narrowed value, so their non-null type is fixed.
  const stack = stackEl;
  const vars = varsEl;

  const session = new DebugSession();
  let seq = 1;
  let paused = false;

  function send(command: string, args?: unknown): ReturnType<DebugSession['handleRequest']> {
    const request: Request = { seq: seq++, type: 'request', command, ...(args !== undefined ? { arguments: args } : {}) };
    return session.handleRequest(request);
  }

  function renderStackAndVariables(): void {
    const stackMessages = send('stackTrace', { threadId: 1 });
    const stackResponse = stackMessages.find((m) => m.type === 'response');
    const frames = (stackResponse && stackResponse.type === 'response' ? (stackResponse.body as StackTraceResponseBody) : undefined)?.stackFrames ?? [];

    stack.innerHTML = '';
    for (const frame of frames) {
      const row = document.createElement('div');
      row.textContent = `${frame.name} — line ${frame.line}`;
      stack.appendChild(row);
    }

    vars.innerHTML = '';
    if (frames.length > 0) {
      const scopesMessages = send('scopes', { frameId: frames[0]!.id });
      const scopesResponse = scopesMessages.find((m) => m.type === 'response');
      const scopes = (scopesResponse && scopesResponse.type === 'response' ? (scopesResponse.body as { scopes: { variablesReference: number }[] }) : undefined)?.scopes ?? [];
      const ref = scopes[0]?.variablesReference;
      if (ref !== undefined) {
        const varMessages = send('variables', { variablesReference: ref });
        const varResponse = varMessages.find((m) => m.type === 'response');
        const variables = (varResponse && varResponse.type === 'response' ? (varResponse.body as VariablesResponseBody) : undefined)?.variables ?? [];
        for (const v of variables) {
          const row = document.createElement('div');
          row.className = 'var-row';
          const name = document.createElement('span');
          name.className = 'var-name';
          name.textContent = v.name;
          const value = document.createElement('span');
          value.className = 'var-value';
          value.textContent = v.value;
          row.append(name, value);
          vars.appendChild(row);
        }
      }
    }
  }

  function handleOutcome(messages: ReturnType<DebugSession['handleRequest']>): void {
    for (const msg of messages) {
      if (msg.type === 'event' && msg.event === 'stopped') {
        paused = true;
        const body = msg.body as StoppedEventBody;
        renderStackAndVariables();
        const row = document.createElement('div');
        row.textContent = `paused (${body.reason}) at line ${body.line ?? '?'}`;
        stack.prepend(row);
      }
      if (msg.type === 'event' && msg.event === 'terminated') {
        paused = false;
        stack.innerHTML = '<div>program finished</div>';
        vars.innerHTML = '';
      }
      if (msg.type === 'event' && msg.event === 'output') {
        const body = msg.body as { output: string };
        const row = document.createElement('div');
        row.textContent = body.output;
        stack.appendChild(row);
      }
    }
  }

  runBtn.addEventListener('click', () => {
    send('initialize', {});
    handleOutcome(send('launch', { program }));
    handleOutcome(send('setBreakpoints', { source: { path: 'toy.tf' }, breakpoints: breakpointLines.map((line) => ({ line })) }));
    handleOutcome(send('continue', { threadId: 1 }));
  });

  continueBtn.addEventListener('click', () => {
    if (!paused) return;
    handleOutcome(send('continue', { threadId: 1 }));
  });

  stepOverBtn.addEventListener('click', () => {
    if (!paused) return;
    handleOutcome(send('next', { threadId: 1 }));
  });

  stepInBtn.addEventListener('click', () => {
    if (!paused) return;
    handleOutcome(send('stepIn', { threadId: 1 }));
  });
}
