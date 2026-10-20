import {
  awsIotPublisherFactory,
  type AwsCredentials,
  type IotPublisher,
  type PublisherFactory,
} from './iot';
import { Op, toDeviceArgs } from './ops';
import { awsIotSubscriberFactory, type StateSubscriber, type SubscriberFactory } from './state';
import type { BlickdomiClient, Shutter, ShutterRef } from './types';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_IOT_ENDPOINT = 'https://a28ym2xtz4in9m-ats.iot.eu-west-1.amazonaws.com';
const DEFAULT_IOT_REGION = 'eu-west-1';

export interface HttpClientOptions {
  username: string;
  password: string;
  /** Defaults to 22222 (the port the app uses for auth, discovery and state). */
  port?: number;
  host?: string;
  version?: string;
  /** Account-specific AWS IoT ATS data endpoint. */
  iotEndpoint?: string;
  iotRegion?: string;
  fetchImpl?: FetchLike;
  publisherFactory?: PublisherFactory;
  subscriberFactory?: SubscriberFactory;
  log?: (message: string) => void;
}

interface RemoteEnvelope<T> {
  Remote_Data?: T & {
    Ack?: boolean;
    Error?: { Code?: number; Error_Message?: string } | null;
  };
  /** Gateway-level auth failure uses a different shape. */
  errors?: Array<{ message?: string }>;
}

interface LoginData {
  Pin?: string;
}

interface CredentialsData {
  AccessKey?: string;
  SecretAccessKey?: string;
  SessionToken?: string;
  Expiration?: string;
}

interface BuildingsData {
  Creator_Buildings?: BuildingNode[] | null;
  Associates_Buildings?: BuildingNode[] | null;
}

interface BuildingNode {
  Home?: {
    Id_Home: number;
    Rooms?: Array<{ Room?: { Id_Room: number; Windows?: Array<{ Window?: WindowNode }> } }>;
  };
}

interface WindowNode {
  Id_Window: string;
  Ip?: string;
  Name?: string;
  Firmware?: string;
}

interface CachedCreds {
  publisher: IotPublisher;
  expiresAt: number;
}

const WINDOW_ID_RE = /^AC1101200000([0-9A-Fa-f]{12})SOL$/;

/** `AC1101200000AABBCCDDEEFFSOL` -> `AA:BB:CC:DD:EE:FF`. */
export function macFromWindowId(id: string): string {
  const hex = WINDOW_ID_RE.exec(id)?.[1];
  if (!hex) {
    return '';
  }
  return (hex.match(/../g) ?? []).join(':').toUpperCase();
}

export class BlickdomiAuthError extends Error {}

export class CloudBlickdomiClient implements BlickdomiClient {
  private readonly base: string;
  private readonly iotEndpoint: string;
  private readonly iotRegion: string;
  private readonly fetchImpl: FetchLike;
  private readonly publisherFactory: PublisherFactory;
  private readonly subscriberFactory: SubscriberFactory;
  private readonly log: (message: string) => void;
  private token?: string;
  private readonly publishers = new Map<number, CachedCreds>();
  private readonly subscriptions = new Map<number, StateSubscriber>();

  constructor(private readonly options: HttpClientOptions) {
    const host = options.host ?? 'www.mysmartwindow.com';
    const port = options.port ?? 22222;
    const version = options.version ?? 'v3';
    this.base = `https://${host}:${port}/hope/${version}`;
    this.iotEndpoint = options.iotEndpoint ?? DEFAULT_IOT_ENDPOINT;
    this.iotRegion = options.iotRegion ?? DEFAULT_IOT_REGION;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.publisherFactory = options.publisherFactory ?? awsIotPublisherFactory;
    this.subscriberFactory = options.subscriberFactory ?? awsIotSubscriberFactory;
    this.log = options.log ?? (() => {});
  }

  async listShutters(): Promise<Shutter[]> {
    const env = await this.authed<BuildingsData>('/users/buildings?device_token=');
    const nodes = [
      ...(env.Remote_Data?.Creator_Buildings ?? []),
      ...(env.Remote_Data?.Associates_Buildings ?? []),
    ];

    const shutters: Shutter[] = [];
    for (const node of nodes) {
      const home = node.Home;
      if (!home) {
        continue;
      }
      for (const roomWrap of home.Rooms ?? []) {
        const room = roomWrap.Room;
        if (!room) {
          continue;
        }
        for (const windowWrap of room.Windows ?? []) {
          const win = windowWrap.Window;
          if (!win?.Id_Window) {
            continue;
          }
          shutters.push({
            id: win.Id_Window,
            homeId: home.Id_Home,
            roomId: room.Id_Room,
            name: win.Name ?? win.Id_Window,
            ip: win.Ip ?? '',
            mac: macFromWindowId(win.Id_Window),
            firmware: win.Firmware,
          });
        }
      }
    }
    return shutters;
  }

  open(ref: ShutterRef): Promise<void> {
    return this.publish(ref, { op: Op.UP });
  }

  close(ref: ShutterRef): Promise<void> {
    return this.publish(ref, { op: Op.DOWN });
  }

  stop(ref: ShutterRef): Promise<void> {
    return this.publish(ref, { op: Op.STOP });
  }

  setPosition(ref: ShutterRef, position: number): Promise<void> {
    return this.publish(ref, { op: Op.BLIND_UNIT, args: toDeviceArgs(position) });
  }

  async subscribeState(
    homeId: number,
    onState: (windowId: string, position: number) => void,
  ): Promise<void> {
    if (this.subscriptions.has(homeId)) {
      return;
    }
    const creds = await this.fetchCredentials(homeId);
    const subscriber = this.subscriberFactory(
      {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      },
      this.iotEndpoint,
      this.iotRegion,
      (message) => onState(message.windowId, message.position),
      (error) => this.log(`state subscription error: ${error.message}`),
    );
    subscriber.subscribe(`${homeId}/#`);
    this.subscriptions.set(homeId, subscriber);
    this.scheduleCredentialRefresh(homeId, subscriber, creds.expiresAt);
  }

  /**
   * Refresh the subscription's temp credentials in place before they expire,
   * keeping the one MQTT connection alive instead of letting it reconnect-loop
   * on stale credentials.
   */
  private scheduleCredentialRefresh(
    homeId: number,
    subscriber: StateSubscriber,
    expiresAt: number,
  ): void {
    const DAY = 24 * 60 * 60 * 1000;
    const delay = Math.min(DAY, Math.max(60_000, expiresAt - Date.now()));
    const timer = setTimeout(() => {
      void (async () => {
        if (this.subscriptions.get(homeId) !== subscriber) {
          return;
        }
        try {
          const creds = await this.fetchCredentials(homeId);
          subscriber.updateCredentials({
            accessKeyId: creds.accessKeyId,
            secretAccessKey: creds.secretAccessKey,
            sessionToken: creds.sessionToken,
          });
          this.scheduleCredentialRefresh(homeId, subscriber, creds.expiresAt);
        } catch (error) {
          this.log(`credential refresh failed, retrying: ${(error as Error).message}`);
          this.scheduleCredentialRefresh(homeId, subscriber, Date.now() + 60_000);
        }
      })();
    }, delay);
    timer.unref?.();
  }

  private async publish(ref: ShutterRef, payload: Record<string, number>): Promise<void> {
    const topic = `${ref.homeId}/${ref.id}/blind`;
    const body = JSON.stringify(payload);
    try {
      await (await this.publisherFor(ref.homeId)).publish(topic, body);
    } catch (error) {
      // Credentials may have expired; refresh once and retry.
      this.log(`publish failed, refreshing credentials: ${(error as Error).message}`);
      this.publishers.delete(ref.homeId);
      await (await this.publisherFor(ref.homeId)).publish(topic, body);
    }
  }

  private async publisherFor(homeId: number): Promise<IotPublisher> {
    const cached = this.publishers.get(homeId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.publisher;
    }
    const creds = await this.fetchCredentials(homeId);
    const publisher = this.publisherFactory(
      {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      },
      this.iotEndpoint,
      this.iotRegion,
    );
    this.publishers.set(homeId, { publisher, expiresAt: creds.expiresAt });
    return publisher;
  }

  private async fetchCredentials(homeId: number): Promise<AwsCredentials & { expiresAt: number }> {
    const env = await this.authed<CredentialsData>(`/aws/credentials?id_home=${homeId}`);
    const data = env.Remote_Data;
    if (!data?.AccessKey || !data.SecretAccessKey || !data.SessionToken) {
      throw new BlickdomiAuthError('no AWS credentials returned');
    }
    const parsed = data.Expiration ? Date.parse(data.Expiration) : NaN;
    const expiresAt = Number.isNaN(parsed) ? Date.now() + 30 * 60_000 : parsed - 60_000;
    return {
      accessKeyId: data.AccessKey,
      secretAccessKey: data.SecretAccessKey,
      sessionToken: data.SessionToken,
      expiresAt,
    };
  }

  /** Run a GET with the bearer token, re-logging in once on an auth failure. */
  private async authed<T>(path: string, init: RequestInit = {}): Promise<RemoteEnvelope<T>> {
    await this.ensureToken();
    let env = await this.send<T>(path, init);
    if (isAuthError(env)) {
      this.log('token rejected, re-authenticating');
      this.token = undefined;
      await this.ensureToken();
      env = await this.send<T>(path, init);
    }
    if (isAuthError(env)) {
      throw new BlickdomiAuthError('authentication rejected by mySmartWindow');
    }
    return env;
  }

  private async send<T>(path: string, init: RequestInit): Promise<RemoteEnvelope<T>> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      ...init,
      headers: { ...commonHeaders(), ...init.headers, Authorization: `Bearer ${this.token}` },
    });
    return parseEnvelope<T>(res);
  }

  private async ensureToken(): Promise<void> {
    if (this.token) {
      return;
    }
    const auth = Buffer.from(`${this.options.username}:${this.options.password}`).toString(
      'base64',
    );
    const res = await this.fetchImpl(`${this.base}/authentication`, {
      headers: { ...commonHeaders(), Authorization: `Basic ${auth}` },
      redirect: 'manual',
    });
    const env = await parseEnvelope<LoginData>(res);
    const pin = env.Remote_Data?.Pin;
    if (!pin) {
      throw new BlickdomiAuthError('login failed: no Pin in response');
    }
    this.token = pin;
  }
}

/** The gateway WAF rejects requests without a browser/CLI-like Accept header. */
function commonHeaders(): Record<string, string> {
  return { Accept: '*/*' };
}

async function parseEnvelope<T>(res: Response): Promise<RemoteEnvelope<T>> {
  const text = await res.text();
  let body: RemoteEnvelope<T> = {};
  try {
    body = text ? (JSON.parse(text) as RemoteEnvelope<T>) : {};
  } catch {
    // Non-JSON bodies (e.g. the IIS 411 HTML page) surface as a status error below.
    body = {};
  }
  if (!res.ok && !body.errors && !body.Remote_Data) {
    throw new Error(`HTTP ${res.status}`);
  }
  return body;
}

function isAuthError(env: RemoteEnvelope<unknown>): boolean {
  return (env.errors ?? []).some((e) => /invalid access token/i.test(e.message ?? ''));
}
