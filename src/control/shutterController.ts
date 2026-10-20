import type { BlickdomiClient, ShutterRef } from '../client/types';
import { clampPosition, planCommand } from './position';

/** Numeric values match HAP `Characteristic.PositionState`. */
export const PositionState = {
  DECREASING: 0,
  INCREASING: 1,
  STOPPED: 2,
} as const;
export type PositionStateValue = (typeof PositionState)[keyof typeof PositionState];

export interface ControllerState {
  current: number;
  target: number;
  positionState: PositionStateValue;
}

export interface ShutterControllerOptions {
  client: BlickdomiClient;
  ref: ShutterRef;
  /** Time for a full 0↔100 travel, used to estimate position (no live feedback). */
  fullTravelMs?: number;
  initialPosition?: number;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel?: (handle: ReturnType<typeof setTimeout>) => void;
  onUpdate?: (state: ControllerState) => void;
}

/**
 * HAP-free control logic for one shutter. The cloud API gives no live position,
 * so position is modelled optimistically from the issued commands and elapsed
 * travel time; HomeKit still gets smooth Current/Target/State updates.
 */
export class ShutterController {
  private readonly client: BlickdomiClient;
  private readonly ref: ShutterRef;
  private readonly fullTravelMs: number;
  private readonly now: () => number;
  private readonly schedule: NonNullable<ShutterControllerOptions['schedule']>;
  private readonly cancel: NonNullable<ShutterControllerOptions['cancel']>;
  private readonly onUpdate?: (state: ControllerState) => void;

  private settled: number;
  private target: number;
  private positionState: PositionStateValue = PositionState.STOPPED;

  private moving = false;
  private from = 0;
  private startedAt = 0;
  private duration = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(options: ShutterControllerOptions) {
    this.client = options.client;
    this.ref = options.ref;
    this.fullTravelMs = options.fullTravelMs ?? 20_000;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle));
    this.onUpdate = options.onUpdate;
    this.settled = clampPosition(options.initialPosition ?? 0);
    this.target = this.settled;
  }

  getCurrentPosition(): number {
    if (!this.moving) {
      return this.settled;
    }
    const fraction =
      this.duration > 0 ? Math.min(1, (this.now() - this.startedAt) / this.duration) : 1;
    return clampPosition(this.from + (this.target - this.from) * fraction);
  }

  getTargetPosition(): number {
    return this.target;
  }

  getPositionState(): PositionStateValue {
    return this.positionState;
  }

  async setTarget(target: number): Promise<void> {
    const to = clampPosition(target);
    const command = planCommand(this.getCurrentPosition(), to);
    if (command.kind === 'noop') {
      return;
    }

    this.from = this.getCurrentPosition();
    this.target = to;
    this.startedAt = this.now();
    this.duration = (this.fullTravelMs * Math.abs(to - this.from)) / 100;
    this.moving = true;
    this.positionState = to > this.from ? PositionState.INCREASING : PositionState.DECREASING;
    this.emit();

    switch (command.kind) {
      case 'open':
        await this.client.open(this.ref);
        break;
      case 'close':
        await this.client.close(this.ref);
        break;
      case 'position':
        await this.client.setPosition(this.ref, command.position);
        break;
    }

    this.arm(() => this.settle());
  }

  /**
   * Adopt a position the device reported. The device only pushes after it has
   * settled, so a report means "stopped here" — this is the source of truth and
   * supersedes the optimistic estimate.
   */
  onReported(position: number): void {
    if (this.timer) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
    this.settled = clampPosition(position);
    this.target = this.settled;
    this.moving = false;
    this.positionState = PositionState.STOPPED;
    this.emit();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
    this.settled = this.getCurrentPosition();
    this.target = this.settled;
    this.moving = false;
    this.positionState = PositionState.STOPPED;
    this.emit();
    await this.client.stop(this.ref);
  }

  private settle(): void {
    this.settled = this.target;
    this.moving = false;
    this.timer = undefined;
    this.positionState = PositionState.STOPPED;
    this.emit();
  }

  private arm(fn: () => void): void {
    if (this.timer) {
      this.cancel(this.timer);
    }
    this.timer = this.schedule(fn, this.duration);
  }

  private emit(): void {
    this.onUpdate?.({
      current: this.getCurrentPosition(),
      target: this.target,
      positionState: this.positionState,
    });
  }
}
