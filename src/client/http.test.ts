import { beforeEach, describe, expect, it } from 'vitest';

import { BlickdomiAuthError, CloudBlickdomiClient, isWindowOnline, macFromWindowId } from './http';
import type { FetchLike } from './http';
import type { IotPublisher, PublisherFactory } from './iot';
import type { StateMessage, StateSubscriber, SubscriberFactory } from './state';

const ref = { id: 'AC1101200000AABBCCDDEEFFSOL', homeId: 1, roomId: 1 };

const BUILDINGS = {
  Remote_Data: {
    Creator_Buildings: [
      {
        Home: {
          Id_Home: 1,
          Rooms: [
            {
              Room: {
                Id_Room: 1,
                Windows: [
                  {
                    Window: {
                      Id_Window: 'AC1101200000AABBCCDDEEFFSOL',
                      Ip: '192.168.1.50',
                      Name: 'Living Room',
                      Firmware: '0.2.1.13',
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    ],
    Associates_Buildings: null,
    Ack: true,
    Error: null,
  },
};

const CREDS = {
  Remote_Data: {
    AccessKey: 'AKIA',
    SecretAccessKey: 'secret',
    SessionToken: 'token',
    Expiration: '2999-01-01T00:00:00Z',
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('macFromWindowId', () => {
  it('extracts the colon MAC from a window id', () => {
    expect(macFromWindowId('AC1101200000AABBCCDDEEFFSOL')).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('returns empty on an unexpected id', () => {
    expect(macFromWindowId('nonsense')).toBe('');
  });
});

describe('isWindowOnline', () => {
  // Parsed in the same local format as Last_Connection, so the test is TZ-independent.
  const now = Date.parse('2026-10-21 12:00:00');

  it('is offline when Active is 0', () => {
    expect(isWindowOnline(0, undefined, 0, now)).toBe(false);
  });

  it('is online when Active is 1', () => {
    expect(isWindowOnline(1, undefined, 0, now)).toBe(true);
  });

  it('treats missing fields as online (never a false offline)', () => {
    expect(isWindowOnline(undefined, undefined, 0, now)).toBe(true);
  });

  it('ignores staleness when the threshold is 0', () => {
    expect(isWindowOnline(1, '2020-01-01 00:00:00', 0, now)).toBe(true);
  });

  it('is offline when Last_Connection is older than the stale window', () => {
    expect(isWindowOnline(1, '2026-10-21 10:00:00', 30 * 60_000, now)).toBe(false);
  });

  it('is online when Last_Connection is within the stale window', () => {
    expect(isWindowOnline(1, '2026-10-21 11:50:00', 30 * 60_000, now)).toBe(true);
  });
});

describe('CloudBlickdomiClient', () => {
  let calls: Array<{ url: string; init?: RequestInit }>;
  let published: Array<{ topic: string; payload: string }>;
  let publisherFactory: PublisherFactory;
  let subscribedFilters: string[];
  let emitState: ((message: StateMessage) => void) | undefined;
  let subscriberFactory: SubscriberFactory;

  function clientWith(fetchImpl: FetchLike): CloudBlickdomiClient {
    return new CloudBlickdomiClient({
      username: 'u@example.com',
      password: 'pw',
      fetchImpl,
      publisherFactory,
      subscriberFactory,
    });
  }

  function recording(handler: FetchLike): FetchLike {
    return (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    };
  }

  /** Login + AWS creds for any request; buildings/state handled by the caller. */
  function withAuth(handler: FetchLike): FetchLike {
    return recording(async (url, init) => {
      if (url.endsWith('/authentication')) {
        return json({ Remote_Data: { Pin: 'PIN123' } });
      }
      if (url.includes('/aws/credentials')) {
        return json(CREDS);
      }
      return handler(url, init);
    });
  }

  beforeEach(() => {
    calls = [];
    published = [];
    subscribedFilters = [];
    emitState = undefined;
    const publisher: IotPublisher = {
      async publish(topic, payload) {
        published.push({ topic, payload });
      },
    };
    publisherFactory = () => publisher;
    subscriberFactory = (_creds, _endpoint, _region, onState) => {
      emitState = onState;
      const subscriber: StateSubscriber = {
        subscribe: (filter) => subscribedFilters.push(filter),
        updateCredentials: () => {},
        close: () => {},
      };
      return subscriber;
    };
  });

  it('logs in then lists shutters with the bearer token', async () => {
    const client = clientWith(withAuth(async () => json(BUILDINGS)));

    const shutters = await client.listShutters();

    expect(shutters).toHaveLength(1);
    expect(shutters[0]).toMatchObject({
      id: 'AC1101200000AABBCCDDEEFFSOL',
      homeId: 1,
      roomId: 1,
      name: 'Living Room',
      mac: 'AA:BB:CC:DD:EE:FF',
    });
    const buildingsCall = calls.find((c) => c.url.includes('/users/buildings'));
    expect(buildingsCall?.init?.headers).toMatchObject({ Authorization: 'Bearer PIN123' });
  });

  it('publishes up/down/stop to the blind topic via IoT', async () => {
    const client = clientWith(withAuth(async () => json({})));

    await client.open(ref);
    await client.close(ref);
    await client.stop(ref);

    expect(published).toEqual([
      { topic: '1/AC1101200000AABBCCDDEEFFSOL/blind', payload: '{"op":7}' },
      { topic: '1/AC1101200000AABBCCDDEEFFSOL/blind', payload: '{"op":8}' },
      { topic: '1/AC1101200000AABBCCDDEEFFSOL/blind', payload: '{"op":9}' },
    ]);
  });

  it('inverts HomeKit position to the device percent-closed arg', async () => {
    const client = clientWith(withAuth(async () => json({})));

    await client.setPosition(ref, 30); // 30% open -> 70% closed

    expect(published[0]).toEqual({
      topic: '1/AC1101200000AABBCCDDEEFFSOL/blind',
      payload: '{"op":63,"args":70}',
    });
  });

  it('vends AWS credentials once and reuses the publisher', async () => {
    const client = clientWith(withAuth(async () => json({})));

    await client.open(ref);
    await client.close(ref);

    expect(calls.filter((c) => c.url.includes('/aws/credentials'))).toHaveLength(1);
  });

  it('subscribes to the home topic and dispatches parsed readings', async () => {
    const client = clientWith(withAuth(async () => json({})));
    const seen: Array<{ windowId: string; position?: number }> = [];

    await client.subscribeState(ref.homeId, (windowId, readings) =>
      seen.push({ windowId, position: readings.position }),
    );

    expect(subscribedFilters).toEqual(['1/#']);
    emitState?.({ windowId: ref.id, readings: { position: 42 } });
    expect(seen).toEqual([{ windowId: ref.id, position: 42 }]);
  });

  it('reports per-window reachability from the Active flag', async () => {
    const buildings = {
      Remote_Data: {
        Creator_Buildings: [
          {
            Home: {
              Id_Home: 1,
              Rooms: [
                {
                  Room: {
                    Id_Room: 1,
                    Windows: [
                      { Window: { Id_Window: 'WIN-ON', Active: 1 } },
                      { Window: { Id_Window: 'WIN-OFF', Active: 0 } },
                    ],
                  },
                },
              ],
            },
          },
        ],
        Ack: true,
      },
    };
    const client = clientWith(withAuth(async () => json(buildings)));

    const reachable = await client.getReachability(1);
    expect(reachable.get('WIN-ON')).toBe(true);
    expect(reachable.get('WIN-OFF')).toBe(false);
  });

  it('subscribes to a home only once', async () => {
    const client = clientWith(withAuth(async () => json({})));

    await client.subscribeState(ref.homeId, () => {});
    await client.subscribeState(ref.homeId, () => {});

    expect(subscribedFilters).toEqual(['1/#']);
  });

  it('re-authenticates once on an invalid-token envelope', async () => {
    let buildingsCalls = 0;
    const client = clientWith(
      recording(async (url) => {
        if (url.endsWith('/authentication')) {
          return json({ Remote_Data: { Pin: 'PIN' } });
        }
        buildingsCalls += 1;
        if (buildingsCalls === 1) {
          return json({ errors: [{ message: 'Invalid Access Token' }] });
        }
        return json(BUILDINGS);
      }),
    );

    await expect(client.listShutters()).resolves.toHaveLength(1);
    expect(buildingsCalls).toBe(2);
  });

  it('raises an auth error when login returns no Pin', async () => {
    const client = clientWith(async () => json({ Remote_Data: { Ack: false } }));
    await expect(client.listShutters()).rejects.toBeInstanceOf(BlickdomiAuthError);
  });
});
