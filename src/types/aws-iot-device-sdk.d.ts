declare module 'aws-iot-device-sdk' {
  export interface DeviceOptions {
    host: string;
    protocol?: string;
    region?: string;
    accessKeyId?: string;
    secretKey?: string;
    sessionToken?: string;
  }

  export interface Device {
    on(event: 'message', cb: (topic: string, payload: Buffer) => void): void;
    on(event: 'connect' | 'close' | 'offline' | 'reconnect', cb: () => void): void;
    on(event: 'error', cb: (error: Error) => void): void;
    subscribe(topic: string): void;
    updateWebSocketCredentials(
      accessKeyId: string,
      secretKey: string,
      sessionToken: string,
      expiration?: Date,
    ): void;
    end(force?: boolean): void;
  }

  export function device(options: DeviceOptions): Device;

  const _default: { device: typeof device };
  export default _default;
}
