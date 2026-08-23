/**
 * The default program the debug panel opens with, in @titanforge/dap's toy scripting language —
 * a concrete, working example so the debug panel has something real to step through out of the
 * box, per the task's requirement. Sums 1..5 in a while loop; the breakpoint below lands inside
 * the loop body so "Continue" re-hits it on each iteration and "sum"/"i" are visibly live
 * variables in the Variables panel at each pause.
 */
export const TOY_DEBUG_PROGRAM = `let sum = 0;
let i = 1;
while (i <= 5) {
  sum = sum + i;
  i = i + 1;
}
print(sum);
`;

// Line 4 ("sum = sum + i;") is inside the loop body — a natural place to pause and inspect state.
export const TOY_DEBUG_BREAKPOINT_LINES = [4];
