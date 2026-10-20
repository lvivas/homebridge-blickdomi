/** Device operation codes. */
export const Op = {
  /** Read/report blind position (percent closed). Used for state, not control. */
  POSITION_BLIND: 6,
  UP: 7,
  DOWN: 8,
  STOP: 9,
  /** Move to an absolute position; args = percent closed (0 open … 100 closed). */
  BLIND_UNIT: 63,
} as const;

/** Device position arg is percent-closed; HomeKit position is percent-open. */
export function toDeviceArgs(homekitPosition: number): number {
  return 100 - homekitPosition;
}

/** Inverse of {@link toDeviceArgs}. */
export function fromDeviceValue(deviceValue: number): number {
  return 100 - deviceValue;
}
