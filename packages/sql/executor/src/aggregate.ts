import type { BoundExpr } from '@titanforge/catalog';
import type { SqlValue } from '@titanforge/storage-api';
import { ExecutionError } from './expr.js';

/**
 * Per-group running state for one aggregate `call` expression. `SUM`/`AVG`/`MIN`/`MAX` skip
 * `NULL` inputs, matching real SQL aggregate semantics. Judgment calls, documented here since
 * the brief asks for them to be explicit:
 *  - `SUM` over zero rows (or all-`NULL` inputs) is `0`, not `NULL` — this project's choice; some
 *    engines (e.g. Postgres) return `NULL` instead, but `0` composes better with arithmetic
 *    downstream (`SUM(x) + 1` never becomes `NULL` just because a group was empty).
 *  - `AVG` over zero rows (or all-`NULL`) is `NULL` — there is no sane non-`NULL` average of no
 *    numbers, and `0` would be actively misleading (indistinguishable from "the average is
 *    actually zero").
 *  - `MIN`/`MAX` over zero rows (or all-`NULL`) is `NULL` — nothing to compare.
 *  - `COUNT(*)` (zero `args`, per the binder) counts rows in the group, `NULL`s included.
 *    `COUNT(expr)` counts only the group's non-`NULL` evaluations of `expr`.
 */
export class AggregateState {
  private countValue = 0;
  private sumValue = 0;
  private sawNonNull = false;
  private minValue: SqlValue = null;
  private maxValue: SqlValue = null;

  constructor(private readonly name: string, private readonly countStar: boolean) {}

  add(value: SqlValue): void {
    if (this.countStar) {
      this.countValue += 1;
      return;
    }
    if (value === null) return;
    this.countValue += 1;
    this.sawNonNull = true;
    if (typeof value === 'number') {
      this.sumValue += value;
      if (this.minValue === null || value < (this.minValue as number)) this.minValue = value;
      if (this.maxValue === null || value > (this.maxValue as number)) this.maxValue = value;
    } else {
      if (this.minValue === null || value < (this.minValue as string)) this.minValue = value;
      if (this.maxValue === null || value > (this.maxValue as string)) this.maxValue = value;
    }
  }

  finish(): SqlValue {
    switch (this.name) {
      case 'COUNT':
        return this.countValue;
      case 'SUM':
        return this.sawNonNull ? this.sumValue : 0;
      case 'AVG':
        return this.sawNonNull ? this.sumValue / this.countValue : null;
      case 'MIN':
        return this.minValue;
      case 'MAX':
        return this.maxValue;
      default:
        throw new ExecutionError(`unknown aggregate function "${this.name}"`);
    }
  }
}

export function makeAggregateState(expr: BoundExpr): AggregateState {
  if (expr.kind !== 'call' || !expr.isAggregate) {
    throw new ExecutionError('expected an aggregate call expression');
  }
  return new AggregateState(expr.name, expr.name === 'COUNT' && expr.args.length === 0);
}
