import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { ShutterAccessory } from './accessory';
import { CloudBlickdomiClient } from './client/http';
import type { BlickdomiClient, Shutter } from './client/types';
import type { BlickdomiPlatformConfig, DeviceConfig, SensorKind } from './config';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

export class BlickdomiPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly client: BlickdomiClient;
  public readonly fullTravelSeconds: number;
  public readonly exposeSensors: boolean;
  public readonly sensorDefaults: Record<SensorKind, boolean>;
  private readonly sensorPollSeconds: number;
  private readonly enableReachability: boolean;
  private readonly reachabilityPollSeconds: number;
  private readonly deviceConfigs: DeviceConfig[];
  private readonly globalTemperatureOffset: number;

  private readonly cachedAccessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    const cfg = config as BlickdomiPlatformConfig;
    this.fullTravelSeconds = cfg.fullTravelSeconds ?? 20;
    this.exposeSensors = cfg.exposeSensors ?? true;
    this.sensorDefaults = {
      airQuality: cfg.exposeAirQuality ?? true,
      co2: cfg.exposeCo2 ?? true,
      temperature: cfg.exposeTemperature ?? true,
      humidity: cfg.exposeHumidity ?? true,
    };
    this.enableReachability = cfg.enableReachability ?? false;
    this.reachabilityPollSeconds = cfg.reachabilityPollSeconds ?? 180;
    this.deviceConfigs = cfg.devices ?? [];
    this.globalTemperatureOffset = cfg.temperatureOffset ?? 0;
    this.sensorPollSeconds = cfg.sensorPollSeconds ?? 300;
    this.client = new CloudBlickdomiClient({
      username: cfg.username ?? '',
      password: cfg.password ?? '',
      port: cfg.port,
      offlineStaleMinutes: cfg.offlineStaleMinutes,
      log: (message) => this.log.debug(message),
    });

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices().catch((error) => {
        this.log.error('Discovery failed:', (error as Error).message);
      });
    });
  }

  /** Per-device sensor override from config (by name or window id); undefined = auto. */
  sensorOverride(shutter: Shutter, kind: SensorKind): boolean | undefined {
    return this.deviceConfig(shutter)?.[kind];
  }

  /** Temperature offset (°C) for a shutter: per-device if set, else the global value. */
  temperatureOffsetFor(shutter: Shutter): number {
    return this.deviceConfig(shutter)?.temperatureOffset ?? this.globalTemperatureOffset;
  }

  private deviceConfig(shutter: Shutter): DeviceConfig | undefined {
    return this.deviceConfigs.find((d) => d.name === shutter.name || d.name === shutter.id);
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.push(accessory);
  }

  private async discoverDevices(): Promise<void> {
    let shutters: Shutter[];
    try {
      shutters = await this.client.listShutters();
    } catch (error) {
      this.log.error('Failed to list shutters:', (error as Error).message);
      return;
    }

    const seen = new Set<string>();
    const handlers = new Map<string, ShutterAccessory>();
    const homeIds = new Set<number>();
    for (const shutter of shutters) {
      const uuid = this.api.hap.uuid.generate(shutter.id);
      seen.add(uuid);
      homeIds.add(shutter.homeId);

      const existing = this.cachedAccessories.find((a) => a.UUID === uuid);
      if (existing) {
        existing.context.shutter = shutter;
        handlers.set(shutter.id, new ShutterAccessory(this, existing));
        this.log.info('Restored shutter:', shutter.name);
        continue;
      }

      const accessory = new this.api.platformAccessory(shutter.name, uuid);
      accessory.context.shutter = shutter;
      handlers.set(shutter.id, new ShutterAccessory(this, accessory));
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info('Added shutter:', shutter.name);
    }

    const stale = this.cachedAccessories.filter((a) => !seen.has(a.UUID));
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.log.info(`Removed ${stale.length} stale shutter(s)`);
    }

    for (const homeId of homeIds) {
      try {
        await this.client.subscribeState(homeId, (windowId, readings) => {
          handlers.get(windowId)?.report(readings);
        });
      } catch (error) {
        this.log.warn(`Live state unavailable for home ${homeId}:`, (error as Error).message);
      }
    }

    if (this.exposeSensors) {
      this.startSensorPolling(shutters);
    }
    if (this.enableReachability) {
      this.startReachabilityPolling(homeIds, handlers);
    }
  }

  /** Ask each shutter for a fresh full reading now and on an interval (device op 62). */
  private startSensorPolling(shutters: Shutter[]): void {
    const poll = (): void => {
      for (const s of shutters) {
        this.client
          .requestSensors({ id: s.id, homeId: s.homeId, roomId: s.roomId })
          .catch((error) =>
            this.log.debug(`Sensor request failed for ${s.name}: ${error.message}`),
          );
      }
    };
    poll();
    if (this.sensorPollSeconds > 0) {
      setInterval(poll, this.sensorPollSeconds * 1000).unref?.();
    }
  }

  private startReachabilityPolling(
    homeIds: Set<number>,
    handlers: Map<string, ShutterAccessory>,
  ): void {
    const poll = async (): Promise<void> => {
      for (const homeId of homeIds) {
        try {
          const reachable = await this.client.getReachability(homeId);
          for (const [windowId, online] of reachable) {
            handlers.get(windowId)?.setReachable(online);
          }
        } catch (error) {
          this.log.debug(
            `Reachability poll failed for home ${homeId}: ${(error as Error).message}`,
          );
        }
      }
    };
    void poll();
    setInterval(() => void poll(), this.reachabilityPollSeconds * 1000).unref?.();
  }
}
