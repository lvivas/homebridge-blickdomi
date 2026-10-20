import { describe, expect, it } from 'vitest';

import { parseStatePayload } from './state';

const WINDOW = 'AC1101200000AABBCCDDEEFFSOL';
const topic = `1/${WINDOW}/state`;

describe('parseStatePayload', () => {
  it('maps a fully-open report (value 0) to HomeKit 100', () => {
    const msg = parseStatePayload(topic, JSON.stringify({ data: [{ op: '6', value: 0 }] }));
    expect(msg).toEqual({ windowId: WINDOW, position: 100 });
  });

  it('clamps an over-closed report (value 120) to HomeKit 0', () => {
    const msg = parseStatePayload(topic, JSON.stringify({ data: [{ op: '6', value: 120 }] }));
    expect(msg).toEqual({ windowId: WINDOW, position: 0 });
  });

  it('maps a mid report to the inverted position', () => {
    const msg = parseStatePayload(topic, JSON.stringify({ data: [{ op: 6, value: 60 }] }));
    expect(msg).toEqual({ windowId: WINDOW, position: 40 });
  });

  it('ignores non-state topics', () => {
    expect(parseStatePayload(`1/${WINDOW}/blind`, '{"op":7}')).toBeUndefined();
  });

  it('ignores payloads without a position op', () => {
    expect(
      parseStatePayload(topic, JSON.stringify({ data: [{ op: '56', value: 1 }] })),
    ).toBeUndefined();
  });

  it('ignores malformed payloads', () => {
    expect(parseStatePayload(topic, 'not json')).toBeUndefined();
  });
});
