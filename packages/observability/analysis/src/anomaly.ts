/**
 * Flags `newDuration` as anomalous when it sits more than `k` standard deviations from the mean
 * of `historicalDurations` — the classic z-score outlier test. `k` defaults to 3: for a
 * roughly-normal latency distribution, ~99.7% of samples fall within 3 stddevs, so a 3-sigma flag
 * keeps the false-positive rate low on ordinary jitter while still catching real regressions
 * (a p99 latency spike is, definitionally, a multi-sigma event).
 *
 * Fewer than two historical samples can't produce a meaningful stddev (population stddev of a
 * single point is 0, which would make *any* deviation from it "infinitely anomalous") — with too
 * little history to judge, this deliberately returns `false` rather than false-positiving on the
 * first couple of data points a service ever sees.
 */
export function detectAnomalies(historicalDurations: number[], newDuration: number, k = 3): boolean {
  if (historicalDurations.length < 2) return false;

  const mean = historicalDurations.reduce((a, b) => a + b, 0) / historicalDurations.length;
  const variance = historicalDurations.reduce((sum, v) => sum + (v - mean) ** 2, 0) / historicalDurations.length;
  const stddev = Math.sqrt(variance);

  if (stddev === 0) return newDuration !== mean;

  return Math.abs(newDuration - mean) > k * stddev;
}

/**
 * Stateful rolling-window wrapper around `detectAnomalies` for callers that observe durations one
 * at a time (e.g. the server ingesting spans as they arrive) rather than holding a full history
 * array. `windowSize` bounds memory and lets the detector track a *recent* baseline instead of an
 * all-time one — a service's "normal" latency can legitimately drift over weeks, and an unbounded
 * history would make the detector increasingly insensitive to that drift.
 */
export class AnomalyDetector {
  private readonly window: number[] = [];

  constructor(
    private readonly windowSize = 100,
    private readonly k = 3,
  ) {
    if (windowSize < 2) throw new RangeError('windowSize must be at least 2');
  }

  /** Checks `duration` against the current window, then folds it into the window for future checks — mirrors how spans actually arrive: judge, then learn. */
  observe(duration: number): boolean {
    const isAnomalous = detectAnomalies(this.window, duration, this.k);
    this.window.push(duration);
    if (this.window.length > this.windowSize) this.window.shift();
    return isAnomalous;
  }

  get sampleCount(): number {
    return this.window.length;
  }
}
