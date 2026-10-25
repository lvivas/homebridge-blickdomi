/**
 * Device-facing seam between the mySmartWindow cloud and the HAP mapping.
 * Everything HomeKit-specific lives above this; everything transport-specific
 * lives in the concrete implementation. The HAP mapping depends only on this
 * interface so it can be unit-tested against a mock.
 *
 * Positions in this interface are always HomeKit terms: 0 = closed, 100 = open.
 * The device's inverted percent-closed scale is hidden inside the client.
 */

import type { StateReadings } from './state';

export type { StateReadings };

/** A shutter as returned by the cloud `users/buildings` call. */
export interface Shutter {
  /** Cloud window id, e.g. `AC1101200000AABBCCDDEEFFSOL`. */
  readonly id: string;
  readonly homeId: number;
  readonly roomId: number;
  readonly name: string;
  readonly ip: string;
  /** Derived from the window id (`AC1101200000<mac>SOL`). */
  readonly mac: string;
  readonly firmware?: string;
  /** Capability codes from the cloud (e.g. S2 = temp/hum/IAQ, S7 = CO₂/VOC). */
  readonly services: string[];
}

/** The identifiers a command needs to address one shutter. */
export interface ShutterRef {
  readonly id: string;
  readonly homeId: number;
  readonly roomId: number;
}

export interface BlickdomiClient {
  /** Discover every shutter on the account. */
  listShutters(): Promise<Shutter[]>;
  /** Raise fully (device op 7). */
  open(ref: ShutterRef): Promise<void>;
  /** Lower fully (device op 8). */
  close(ref: ShutterRef): Promise<void>;
  /** Halt motion (device op 9). */
  stop(ref: ShutterRef): Promise<void>;
  /** Move to a target position, 0 = closed … 100 = open (device op 63). */
  setPosition(ref: ShutterRef, position: number): Promise<void>;
  /** Ask the device to publish a fresh full sensor report (device op 62). */
  requestSensors(ref: ShutterRef): Promise<void>;
  /**
   * Subscribe to live position pushes for a home. The device only reports after
   * it finishes moving, so `onState` fires per settled position (HomeKit scale).
   */
  subscribeState(
    homeId: number,
    onState: (windowId: string, readings: StateReadings) => void,
  ): Promise<void>;
  /** Per-window reachability for a home: windowId → true when online. */
  getReachability(homeId: number): Promise<Map<string, boolean>>;
}
