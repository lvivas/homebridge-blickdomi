import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BlickdomiClient, ShutterRef } from '../client/types';
import { PositionState, ShutterController } from './shutterController';
import type { ControllerState } from './shutterController';

const ref: ShutterRef = { id: 'AC1101200000AABBCCDDEEFFSOL', homeId: 1, roomId: 1 };

function mockClient(): BlickdomiClient {
  return {
    listShutters: vi.fn().mockResolvedValue([]),
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    setPosition: vi.fn().mockResolvedValue(undefined),
    requestSensors: vi.fn().mockResolvedValue(undefined),
    subscribeState: vi.fn().mockResolvedValue(undefined),
    getReachability: vi.fn().mockResolvedValue(new Map()),
  };
}

describe('ShutterController', () => {
  let client: BlickdomiClient;
  let now: number;
  let pending: (() => void) | undefined;
  let cancel: ReturnType<typeof vi.fn>;
  let updates: ControllerState[];

  function build(initialPosition = 0): ShutterController {
    return new ShutterController({
      client,
      ref,
      fullTravelMs: 10_000,
      initialPosition,
      now: () => now,
      schedule: (fn) => {
        pending = fn;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      cancel,
      onUpdate: (state) => updates.push(state),
    });
  }

  beforeEach(() => {
    client = mockClient();
    now = 0;
    pending = undefined;
    cancel = vi.fn();
    updates = [];
  });

  it('opens on a full-open target and reports increasing', async () => {
    const c = build(0);
    await c.setTarget(100);

    expect(client.open).toHaveBeenCalledWith(ref);
    expect(client.setPosition).not.toHaveBeenCalled();
    expect(c.getTargetPosition()).toBe(100);
    expect(c.getPositionState()).toBe(PositionState.INCREASING);
  });

  it('closes on a full-close target and reports decreasing', async () => {
    const c = build(100);
    await c.setTarget(0);

    expect(client.close).toHaveBeenCalledWith(ref);
    expect(c.getPositionState()).toBe(PositionState.DECREASING);
  });

  it('sends a position command for an intermediate target', async () => {
    const c = build(0);
    await c.setTarget(50);

    expect(client.setPosition).toHaveBeenCalledWith(ref, 50);
  });

  it('does nothing when already at the target', async () => {
    const c = build(40);
    await c.setTarget(40);

    expect(client.open).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
    expect(client.setPosition).not.toHaveBeenCalled();
  });

  it('settles to the target when the travel timer fires', async () => {
    const c = build(0);
    await c.setTarget(100);
    now = 10_000;
    pending?.();

    expect(c.getCurrentPosition()).toBe(100);
    expect(c.getPositionState()).toBe(PositionState.STOPPED);
    expect(updates.at(-1)).toEqual({
      current: 100,
      target: 100,
      positionState: PositionState.STOPPED,
    });
  });

  it('interpolates the current position mid-travel', async () => {
    const c = build(0);
    await c.setTarget(100);
    now = 2_500; // a quarter of the 10s full travel

    expect(c.getCurrentPosition()).toBe(25);
  });

  it('adopts a reported position while idle', () => {
    const c = build(0);
    c.onReported(70);

    expect(c.getCurrentPosition()).toBe(70);
    expect(c.getTargetPosition()).toBe(70);
    expect(c.getPositionState()).toBe(PositionState.STOPPED);
    expect(updates.at(-1)?.current).toBe(70);
  });

  it('settles a move when the device reports it has stopped', async () => {
    const c = build(0);
    await c.setTarget(100);
    expect(c.getPositionState()).toBe(PositionState.INCREASING);

    c.onReported(95); // device settled a touch short of the request
    expect(c.getCurrentPosition()).toBe(95);
    expect(c.getTargetPosition()).toBe(95);
    expect(c.getPositionState()).toBe(PositionState.STOPPED);
    expect(cancel).toHaveBeenCalled();
  });

  it('stop halts, freezes the estimated position, and cancels the timer', async () => {
    const c = build(0);
    await c.setTarget(100);
    now = 3_000;
    await c.stop();

    expect(client.stop).toHaveBeenCalledWith(ref);
    expect(cancel).toHaveBeenCalled();
    expect(c.getPositionState()).toBe(PositionState.STOPPED);
    expect(c.getCurrentPosition()).toBe(30);
    expect(c.getTargetPosition()).toBe(30);
  });
});
