import { describe, expect, it } from 'vitest';
import { AnomalyDetector, detectAnomalies } from '../anomaly.js';

describe('detectAnomalies', () => {
  it('flags a clearly-anomalous duration far outside the historical distribution', () => {
    // History clustered tightly around 100ms; a 900ms sample is a massive, obvious outlier.
    const history = [98, 101, 99, 100, 102, 97, 103, 100, 99, 101];
    expect(detectAnomalies(history, 900)).toBe(true);
  });

  it('does not flag a duration well within normal variance', () => {
    const history = [98, 101, 99, 100, 102, 97, 103, 100, 99, 101];
    expect(detectAnomalies(history, 101)).toBe(false);
  });

  it('does not false-positive with fewer than 2 historical samples', () => {
    expect(detectAnomalies([], 10_000)).toBe(false);
    expect(detectAnomalies([100], 10_000)).toBe(false);
  });

  it('respects a custom k threshold', () => {
    const history = [100, 100, 100, 100, 110, 90]; // mean 100, stddev ~5.77
    // ~1.73 stddevs away: anomalous at k=1, not at the default k=3.
    expect(detectAnomalies(history, 110, 1)).toBe(true);
    expect(detectAnomalies(history, 110, 3)).toBe(false);
  });

  it('treats any deviation from a zero-variance history as anomalous', () => {
    const history = [50, 50, 50, 50];
    expect(detectAnomalies(history, 50)).toBe(false);
    expect(detectAnomalies(history, 51)).toBe(true);
  });

  it('computes a hand-verifiable case exactly at the boundary', () => {
    // Values 10,20,30,40,50 -> mean 30, population variance 200, stddev = sqrt(200) ≈ 14.142.
    // k=1: threshold is 14.142. 44 is 14 away (not anomalous), 45 is 15 away (anomalous).
    const history = [10, 20, 30, 40, 50];
    expect(detectAnomalies(history, 44, 1)).toBe(false);
    expect(detectAnomalies(history, 45, 1)).toBe(true);
  });
});

describe('AnomalyDetector', () => {
  it('does not flag anomalies until it has at least 2 samples', () => {
    const detector = new AnomalyDetector(100, 3);
    expect(detector.observe(100)).toBe(false);
    expect(detector.observe(100_000)).toBe(false); // still only 1 prior sample when judged
    expect(detector.sampleCount).toBe(2);
  });

  it('flags a clear spike once it has enough history', () => {
    const detector = new AnomalyDetector(100, 3);
    for (let i = 0; i < 20; i += 1) detector.observe(100 + (i % 3)); // stable ~100-102ms baseline
    expect(detector.observe(5000)).toBe(true);
  });

  it('does not flag ordinary jitter within the baseline', () => {
    const detector = new AnomalyDetector(100, 3);
    for (let i = 0; i < 20; i += 1) detector.observe(100 + (i % 3));
    expect(detector.observe(101)).toBe(false);
  });

  it('evicts the oldest sample once the rolling window is full', () => {
    const detector = new AnomalyDetector(5, 3);
    for (const v of [10, 10, 10, 10, 10]) detector.observe(v);
    expect(detector.sampleCount).toBe(5);
    detector.observe(10);
    expect(detector.sampleCount).toBe(5); // window capped, not growing unbounded
  });

  it('throws for a windowSize below 2', () => {
    expect(() => new AnomalyDetector(1)).toThrow(RangeError);
  });
});
