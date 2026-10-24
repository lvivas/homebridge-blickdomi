import awsIot from 'aws-iot-device-sdk';

import type { AwsCredentials } from './iot';
import { Op, fromDeviceValue } from './ops';

/** Decoded sensor values from one state push (only present ops are set). */
export interface StateReadings {
  /** HomeKit position, 0 = closed … 100 = open. */
  position?: number;
  temperatureC?: number;
  humidity?: number;
  co2Ppm?: number;
  vocPpm?: number;
  iaq?: number;
}

export interface StateMessage {
  windowId: string;
  readings: StateReadings;
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

/**
 * Parse a device MQTT payload into decoded readings. Position arrives on the
 * `state` topic; sensor readings (temp/humidity/CO₂/VOC/IAQ) arrive, one or
 * more at a time, on the `environmentals` topic. Both use `data:[{op,value}]`.
 */
export function parseStatePayload(topic: string, payload: string): StateMessage | undefined {
  const parts = topic.split('/');
  const leaf = parts[2];
  if (parts.length < 3 || (leaf !== 'state' && leaf !== 'environmentals')) {
    return undefined;
  }
  const windowId = parts[1];

  let body: { data?: Array<{ op: string | number; value: number | string | null }> };
  try {
    body = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!Array.isArray(body.data)) {
    return undefined;
  }

  const readings: StateReadings = {};
  for (const entry of body.data) {
    // Values may be sent as numbers or numeric strings depending on the topic.
    const value = Number(entry.value);
    if (entry.value === null || entry.value === '' || Number.isNaN(value)) {
      continue;
    }
    switch (Number(entry.op)) {
      case Op.POSITION_BLIND:
        readings.position = clamp0to100(fromDeviceValue(value));
        break;
      case Op.TEMP:
        readings.temperatureC = value;
        break;
      case Op.HUMEDAD:
        readings.humidity = clamp0to100(value);
        break;
      case Op.CO2:
        readings.co2Ppm = value;
        break;
      case Op.VOC:
        readings.vocPpm = value;
        break;
      case Op.IAQ:
        readings.iaq = value;
        break;
    }
  }

  if (Object.keys(readings).length === 0) {
    return undefined;
  }
  return { windowId, readings };
}

function clamp0to100(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
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
