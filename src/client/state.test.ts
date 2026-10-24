import { describe, expect, it } from 'vitest';

import { parseStatePayload } from './state';

const WINDOW = 'AC1101200000AABBCCDDEEFFSOL';
const topic = `1/${WINDOW}/state`;

describe('parseStatePayload', () => {
  it('maps a fully-open position report (value 0) to HomeKit 100', () => {
    const msg = parseStatePayload(topic, JSON.stringify({ data: [{ op: '6', value: 0 }] }));
    expect(msg).toEqual({ windowId: WINDOW, readings: { position: 100 } });
  });

  it('clamps an over-closed position report (value 120) to HomeKit 0', () => {
    const msg = parseStatePayload(topic, JSON.stringify({ data: [{ op: '6', value: 120 }] }));
    expect(msg?.readings.position).toBe(0);
  });

  it('decodes temperature, humidity, CO2, VOC and IAQ', () => {
    const msg = parseStatePayload(
      topic,
      JSON.stringify({
        data: [
          { op: 4, value: 21.5 },
          { op: 5, value: 48 },
          { op: 58, value: 820 },
          { op: 59, value: 0.4 },
          { op: 71, value: 75 },
        ],
      }),
    );
    expect(msg?.readings).toEqual({
      temperatureC: 21.5,
      humidity: 48,
      co2Ppm: 820,
      vocPpm: 0.4,
      iaq: 75,
    });
  });

  it('decodes sensor readings on the environmentals topic', () => {
    const msg = parseStatePayload(
      `1/${WINDOW}/environmentals`,
      JSON.stringify({ data: [{ op: 71, value: 51 }] }),
    );
    expect(msg).toEqual({ windowId: WINDOW, readings: { iaq: 51 } });
  });

  it('accepts numeric-string values', () => {
    const msg = parseStatePayload(
      `1/${WINDOW}/environmentals`,
      JSON.stringify({ data: [{ op: '71', value: '51' }] }),
    );
    expect(msg).toEqual({ windowId: WINDOW, readings: { iaq: 51 } });
  });

  it('ignores command/other topics', () => {
    expect(parseStatePayload(`1/${WINDOW}/blind`, '{"op":7}')).toBeUndefined();
  });

  it('ignores payloads with no recognised ops', () => {
    expect(
      parseStatePayload(topic, JSON.stringify({ data: [{ op: '56', value: 1 }] })),
    ).toBeUndefined();
  });

  it('ignores malformed payloads', () => {
    expect(parseStatePayload(topic, 'not json')).toBeUndefined();
  });
});
