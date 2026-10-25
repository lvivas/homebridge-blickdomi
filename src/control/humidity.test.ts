import { describe, expect, it } from 'vitest';

import { correctHumidity } from './humidity';

describe('correctHumidity', () => {
  it('returns the measured value when offset is 0', () => {
    expect(correctHumidity(42, 25, 0)).toBe(42);
  });

  it('raises RH when the temperature is corrected downward', () => {
    // 25 °C / 42 % with a −3 °C offset ≈ 22 °C / ~50 % (same vapour pressure).
    expect(correctHumidity(42, 25, -3)).toBeCloseTo(50, 0);
  });

  it('lowers RH when the temperature is corrected upward', () => {
    expect(correctHumidity(50, 22, 3)).toBeCloseTo(42, 0);
  });

  it('clamps to 0–100', () => {
    expect(correctHumidity(98, 25, -15)).toBeLessThanOrEqual(100);
    expect(correctHumidity(98, 25, -15)).toBeGreaterThan(0);
  });
});
