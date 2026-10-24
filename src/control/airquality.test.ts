import { describe, expect, it } from 'vitest';

import { AirQuality, CarbonDioxideDetected, co2Detected, iaqToAirQuality } from './airquality';

describe('iaqToAirQuality', () => {
  it('buckets the IAQ index into the HomeKit 1–5 scale', () => {
    expect(iaqToAirQuality(0)).toBe(AirQuality.EXCELLENT);
    expect(iaqToAirQuality(50)).toBe(AirQuality.EXCELLENT);
    expect(iaqToAirQuality(51)).toBe(AirQuality.GOOD);
    expect(iaqToAirQuality(100)).toBe(AirQuality.GOOD);
    expect(iaqToAirQuality(150)).toBe(AirQuality.FAIR);
    expect(iaqToAirQuality(200)).toBe(AirQuality.INFERIOR);
    expect(iaqToAirQuality(201)).toBe(AirQuality.POOR);
    expect(iaqToAirQuality(500)).toBe(AirQuality.POOR);
  });

  it('is unknown for NaN', () => {
    expect(iaqToAirQuality(Number.NaN)).toBe(AirQuality.UNKNOWN);
  });
});

describe('co2Detected', () => {
  it('flags abnormal above 1000 ppm', () => {
    expect(co2Detected(800)).toBe(CarbonDioxideDetected.NORMAL);
    expect(co2Detected(1000)).toBe(CarbonDioxideDetected.NORMAL);
    expect(co2Detected(1200)).toBe(CarbonDioxideDetected.ABNORMAL);
  });
});
