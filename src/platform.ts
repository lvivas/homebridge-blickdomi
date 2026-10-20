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
import type { BlickdomiPlatformConfig } from './config';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

export class BlickdomiPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly client: BlickdomiClient;
  public readonly fullTravelSeconds: number;

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
    this.client = new CloudBlickdomiClient({
      username: cfg.username ?? '',
      password: cfg.password ?? '',
      port: cfg.port,
      log: (message) => this.log.debug(message),
    });

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices().catch((error) => {
        this.log.error('Discovery failed:', (error as Error).message);
      });
    });
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
        await this.client.subscribeState(homeId, (windowId, position) => {
          handlers.get(windowId)?.report(position);
        });
      } catch (error) {
        this.log.warn(`Live state unavailable for home ${homeId}:`, (error as Error).message);
      }
    }
  }
}
