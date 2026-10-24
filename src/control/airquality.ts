/**
 * Maps device air-quality readings to HomeKit values. Thresholds are taken from
 * the official app's own display bands (see docs). Numeric results match HAP
 * enums so the accessory can pass them straight through.
 */

/** HAP Characteristic.AirQuality. */
export const AirQuality = {
  UNKNOWN: 0,
  EXCELLENT: 1,
  GOOD: 2,
  FAIR: 3,
  INFERIOR: 4,
  POOR: 5,
} as const;

/** HAP Characteristic.CarbonDioxideDetected. */
export const CarbonDioxideDetected = {
  NORMAL: 0,
  ABNORMAL: 1,
} as const;

/** IAQ index (0 best … ~500 worst) → HomeKit AirQuality 1–5. */
export function iaqToAirQuality(iaq: number): number {
  if (Number.isNaN(iaq)) {
    return AirQuality.UNKNOWN;
  }
  if (iaq <= 50) {
    return AirQuality.EXCELLENT;
  }
  if (iaq <= 100) {
    return AirQuality.GOOD;
  }
  if (iaq <= 150) {
    return AirQuality.FAIR;
  }
  if (iaq <= 200) {
    return AirQuality.INFERIOR;
  }
  return AirQuality.POOR;
}

/** CO₂ ppm → detected flag; the app's second band starts at 1000 ppm. */
export function co2Detected(ppm: number): number {
  return ppm > 1000 ? CarbonDioxideDetected.ABNORMAL : CarbonDioxideDetected.NORMAL;
}
