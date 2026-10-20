import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/** Publishes a QoS-0 message to one MQTT topic. */
export interface IotPublisher {
  publish(topic: string, payload: string): Promise<void>;
}

export type PublisherFactory = (
  credentials: AwsCredentials,
  endpoint: string,
  region: string,
) => IotPublisher;

/** Default publisher backed by the AWS IoT Data plane HTTP API (SigV4). */
export const awsIotPublisherFactory: PublisherFactory = (credentials, endpoint, region) => {
  const client = new IoTDataPlaneClient({ region, endpoint, credentials });
  return {
    async publish(topic, payload) {
      await client.send(
        new PublishCommand({ topic, qos: 0, payload: Buffer.from(payload, 'utf8') }),
      );
    },
  };
};
