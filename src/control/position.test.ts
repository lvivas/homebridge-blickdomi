import { describe, expect, it } from 'vitest';

import { clampPosition, planCommand } from './position';

describe('clampPosition', () => {
  it('rounds and clamps into 0..100', () => {
    expect(clampPosition(42.4)).toBe(42);
    expect(clampPosition(-5)).toBe(0);
    expect(clampPosition(130)).toBe(100);
    expect(clampPosition(Number.NaN)).toBe(0);
  });
});

describe('planCommand', () => {
  it('maps a full-open target to open', () => {
    expect(planCommand(0, 100)).toEqual({ kind: 'open' });
  });

  it('maps a full-close target to close', () => {
    expect(planCommand(100, 0)).toEqual({ kind: 'close' });
  });

  it('maps an intermediate target to a position move', () => {
    expect(planCommand(10, 55)).toEqual({ kind: 'position', position: 55 });
  });

  it('is a no-op when already at the target', () => {
    expect(planCommand(55, 55)).toEqual({ kind: 'noop' });
    expect(planCommand(55.2, 55)).toEqual({ kind: 'noop' });
  });
});
