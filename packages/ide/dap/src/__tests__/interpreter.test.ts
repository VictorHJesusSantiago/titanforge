import { describe, expect, it } from 'vitest';
import { Interpreter } from '../interpreter.js';
import { parse } from '../parser.js';

function runToCompletion(source: string): Interpreter {
  const interp = new Interpreter(parse(source));
  const outcome = interp.run();
  expect(outcome).toBe('done');
  return interp;
}

describe('Interpreter (no breakpoints, run to completion)', () => {
  it('evaluates arithmetic with correct precedence', () => {
    const interp = runToCompletion('print(1 + 2 * 3);');
    expect(interp.getOutput()).toEqual(['7']);
  });

  it('sums 1..10 with a while loop', () => {
    const interp = runToCompletion(`
      let sum = 0;
      let i = 1;
      while (i <= 10) {
        sum = sum + i;
        i = i + 1;
      }
      print(sum);
    `);
    expect(interp.getOutput()).toEqual(['55']);
  });

  it('takes the correct branch of if/else', () => {
    const interp = runToCompletion(`
      let x = 5;
      if (x > 10) {
        print(1);
      } else {
        print(2);
      }
    `);
    expect(interp.getOutput()).toEqual(['2']);
  });

  it('computes factorial via recursion', () => {
    const interp = runToCompletion(`
      function factorial(n) {
        if (n <= 1) {
          return 1;
        }
        return n * factorial(n - 1);
      }
      print(factorial(6));
    `);
    expect(interp.getOutput()).toEqual(['720']);
  });

  it('supports boolean logic and comparisons', () => {
    const interp = runToCompletion('print(3 > 2 && 1 == 1);');
    expect(interp.getOutput()).toEqual(['true']);
  });
});

describe('Interpreter breakpoints and stepping', () => {
  it('genuinely pauses at a breakpoint inside a loop rather than running to completion', () => {
    const source = `
      let sum = 0;
      let i = 1;
      while (i <= 3) {
        sum = sum + i;
        i = i + 1;
      }
      print(sum);
    `;
    const interp = new Interpreter(parse(source));
    // Line 5 is `sum = sum + i;` inside the loop body.
    interp.setBreakpoint(5);
    const outcome = interp.run();
    expect(outcome).toBe('paused');
    expect(interp.getCurrentLine()).toBe(5);
    // Nothing printed yet — execution genuinely stopped before the print statement ran.
    expect(interp.getOutput()).toEqual([]);
  });

  it('reports correct live variable values at the pause point', () => {
    const source = `
      let sum = 0;
      let i = 1;
      while (i <= 3) {
        sum = sum + i;
        i = i + 1;
      }
      print(sum);
    `;
    const interp = new Interpreter(parse(source));
    interp.setBreakpoint(5);
    interp.run();
    const vars = interp.getVariablesInScope(0);
    const byName = Object.fromEntries(vars.map((v) => [v.name, v.value]));
    expect(byName['sum']).toBe('0');
    expect(byName['i']).toBe('1');
  });

  it('continue resumes and hits the same breakpoint again on the next loop iteration', () => {
    const source = `
      let sum = 0;
      let i = 1;
      while (i <= 3) {
        sum = sum + i;
        i = i + 1;
      }
      print(sum);
    `;
    const interp = new Interpreter(parse(source));
    interp.setBreakpoint(5);
    interp.run();
    expect(interp.getVariablesInScope(0).find((v) => v.name === 'i')?.value).toBe('1');

    const secondOutcome = interp.run();
    expect(secondOutcome).toBe('paused');
    expect(interp.getVariablesInScope(0).find((v) => v.name === 'i')?.value).toBe('2');

    const thirdOutcome = interp.run();
    expect(thirdOutcome).toBe('paused');
    expect(interp.getVariablesInScope(0).find((v) => v.name === 'i')?.value).toBe('3');

    // Fourth continue: loop condition now false, runs to completion.
    const fourthOutcome = interp.run();
    expect(fourthOutcome).toBe('done');
    expect(interp.getOutput()).toEqual(['6']);
  });

  it('removeBreakpoint stops execution from pausing there again', () => {
    const source = `
      let i = 0;
      while (i < 3) {
        i = i + 1;
      }
      print(i);
    `;
    const interp = new Interpreter(parse(source));
    interp.setBreakpoint(4);
    interp.run();
    expect(interp.getCurrentLine()).toBe(4);
    interp.removeBreakpoint(4);
    const outcome = interp.run();
    expect(outcome).toBe('done');
    expect(interp.getOutput()).toEqual(['3']);
  });

  it('stepOver moves exactly one statement at the same frame depth', () => {
    const source = `
      let a = 1;
      let b = 2;
      let c = 3;
    `;
    const interp = new Interpreter(parse(source));
    interp.setBreakpoint(2);
    interp.run();
    expect(interp.getCurrentLine()).toBe(2);
    interp.stepOver();
    expect(interp.getCurrentLine()).toBe(3);
    interp.stepOver();
    expect(interp.getCurrentLine()).toBe(4);
  });

  it('stepOver does not descend into a called function', () => {
    const source = `
      function helper() {
        let inner = 42;
        return inner;
      }
      let x = helper();
      let y = x + 1;
    `;
    const interp = new Interpreter(parse(source));
    interp.setBreakpoint(6);
    interp.run();
    expect(interp.getCurrentLine()).toBe(6);
    expect(interp.getCallStack()).toHaveLength(1);
    interp.stepOver();
    // Steps over the whole call to helper() and lands on the next top-level statement.
    expect(interp.getCurrentLine()).toBe(7);
    expect(interp.getCallStack()).toHaveLength(1);
  });

  it('stepIn descends into a called function on the call statement', () => {
    const source = `
      function helper() {
        let inner = 42;
        return inner;
      }
      let x = helper();
    `;
    const interp = new Interpreter(parse(source));
    interp.setBreakpoint(6);
    interp.run();
    expect(interp.getCurrentLine()).toBe(6);
    interp.stepIn();
    // Now paused on the first statement inside helper(), with a deeper call stack.
    expect(interp.getCurrentLine()).toBe(3);
    expect(interp.getCallStack()).toHaveLength(2);
    expect(interp.getCallStack()[0]).toMatchObject({ functionName: 'helper' });
  });
});
