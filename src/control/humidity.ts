/**
 * Correct relative humidity for a temperature offset, holding absolute humidity
 * (vapour pressure) constant: RH_true = RH_meas · Psat(T_meas) / Psat(T_true).
 * Self-heating makes the sensor read warm, which reads RH low; correcting the
 * temperature down raises RH back. Psat uses the Magnus approximation.
 */

function saturationVapourPressure(tempC: number): number {
  return 6.112 * Math.exp((17.62 * tempC) / (243.12 + tempC));
}

export function correctHumidity(
  measuredRh: number,
  measuredTempC: number,
  offsetC: number,
): number {
  if (offsetC === 0) {
    return measuredRh;
  }
  const corrected =
    (measuredRh * saturationVapourPressure(measuredTempC)) /
    saturationVapourPressure(measuredTempC + offsetC);
  return Math.max(0, Math.min(100, corrected));
}
