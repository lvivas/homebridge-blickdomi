import awsIot from 'aws-iot-device-sdk';

import type { AwsCredentials } from './iot';
import { Op, fromDeviceValue } from './ops';

export interface StateMessage {
  windowId: string;
  /** HomeKit position, 0 = closed … 100 = open. */
  position: number;
}

export interface StateSubscriber {
  subscribe(topicFilter: string): void;
  /** Swap in fresh temp credentials without dropping the connection. */
  updateCredentials(credentials: AwsCredentials): void;
  close(): void;
}

export type SubscriberFactory = (
  credentials: AwsCredentials,
  endpoint: string,
  region: string,
  onState: (message: StateMessage) => void,
  onError?: (error: Error) => void,
) => StateSubscriber;

/** Parse a `{home}/{window}/state` MQTT payload into a HomeKit position. */
export function parseStatePayload(topic: string, payload: string): StateMessage | undefined {
  const parts = topic.split('/');
  if (parts.length < 3 || parts[2] !== 'state') {
    return undefined;
  }
  const windowId = parts[1];

  let body: { data?: Array<{ op: string | number; value: number }> };
  try {
    body = JSON.parse(payload);
  } catch {
    return undefined;
  }

  const entry = body.data?.find((d) => Number(d.op) === Op.POSITION_BLIND);
  if (!entry || typeof entry.value !== 'number') {
    return undefined;
  }
  const position = Math.max(0, Math.min(100, Math.round(fromDeviceValue(entry.value))));
  return { windowId, position };
}

/** Live state over AWS IoT MQTT (WebSocket + SigV4 from the temp credentials). */
export const awsIotSubscriberFactory: SubscriberFactory = (
  credentials,
  endpoint,
  region,
  onState,
  onError,
) => {
  const device = awsIot.device({
    host: endpoint.replace(/^https?:\/\//, ''),
    protocol: 'wss',
    region,
    accessKeyId: credentials.accessKeyId,
    secretKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
  });

  device.on('message', (topic, payload) => {
    const message = parseStatePayload(topic, payload.toString());
    if (message) {
      onState(message);
    }
  });
  if (onError) {
    device.on('error', onError);
  }

  return {
    subscribe: (filter) => device.subscribe(filter),
    updateCredentials: (next) =>
      device.updateWebSocketCredentials(next.accessKeyId, next.secretAccessKey, next.sessionToken),
    close: () => device.end(true),
  };
};
