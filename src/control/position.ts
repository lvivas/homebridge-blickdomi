/**
 * HomeKit WindowCovering uses 0 = closed, 100 = open, which matches the device's
 * position argument as far as we have observed. Constant kept as a single place
 * to invert if a live unit proves the scale is reversed.
 */

export type ShutterCommand =
  { kind: 'open' } | { kind: 'close' } | { kind: 'position'; position: number } | { kind: 'noop' };

export function clampPosition(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Choose the device command for a move from `current` to `target`. */
export function planCommand(current: number, target: number): ShutterCommand {
  const to = clampPosition(target);
  if (to === clampPosition(current)) {
    return { kind: 'noop' };
  }
  if (to >= 100) {
    return { kind: 'open' };
  }
  if (to <= 0) {
    return { kind: 'close' };
  }
  return { kind: 'position', position: to };
}
