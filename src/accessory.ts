import type { Characteristic, PlatformAccessory, Service, WithUUID } from 'homebridge';

import type { BlickdomiPlatform } from './platform';
import type { SensorKind } from './config';
import type { Shutter, StateReadings } from './client/types';
import { co2Detected, iaqToAirQuality } from './control/airquality';
import { ShutterController } from './control/shutterController';

type CharacteristicRef = WithUUID<new () => Characteristic>;

/** One sensor characteristic that shows "No Response" until/unless it has data. */
interface SensorChannel {
  service: Service;
  characteristic: CharacteristicRef;
  metric: keyof StateReadings;
}

/** Binds one shutter's WindowCovering (and optional sensor) services. */
export class ShutterAccessory {
  private readonly service: Service;
  private readonly controller: ShutterController;
  private online = true;
  private airService?: Service;
  private tempService?: Service;
  private humService?: Service;
  private co2Service?: Service;
  private readonly channels: SensorChannel[] = [];
  private readonly lastReading = new Map<keyof StateReadings, number>();

  constructor(
    private readonly platform: BlickdomiPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const { Service, Characteristic } = this.platform;
    const shutter = accessory.context.shutter as Shutter;

    this.controller = new ShutterController({
      client: this.platform.client,
      ref: { id: shutter.id, homeId: shutter.homeId, roomId: shutter.roomId },
      fullTravelMs: this.platform.fullTravelSeconds * 1000,
      initialPosition: accessory.context.position as number | undefined,
      onUpdate: (state) => {
        this.service.updateCharacteristic(Characteristic.CurrentPosition, state.current);
        this.service.updateCharacteristic(Characteristic.TargetPosition, state.target);
        this.service.updateCharacteristic(Characteristic.PositionState, state.positionState);
        accessory.context.position = state.current;
      },
    });

    accessory
      .getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, 'Solven / BlickDomi')
      .setCharacteristic(Characteristic.Model, 'Sentry')
      .setCharacteristic(Characteristic.SerialNumber, shutter.mac || shutter.id)
      .setCharacteristic(Characteristic.FirmwareRevision, shutter.firmware ?? '0.0.0');

    this.service =
      accessory.getService(Service.WindowCovering) ??
      accessory.addService(Service.WindowCovering, shutter.name);
    this.service.setCharacteristic(Characteristic.Name, shutter.name);

    this.service
      .getCharacteristic(Characteristic.CurrentPosition)
      .onGet(() => this.assertOnline(this.controller.getCurrentPosition()));

    this.service
      .getCharacteristic(Characteristic.PositionState)
      .onGet(() => this.assertOnline(this.controller.getPositionState()));

    this.service
      .getCharacteristic(Characteristic.TargetPosition)
      .onGet(() => this.assertOnline(this.controller.getTargetPosition()))
      .onSet(async (value) => {
        this.assertOnline(null);
        await this.controller.setTarget(Number(value));
      });

    this.service.getCharacteristic(Characteristic.HoldPosition).onSet(async (value) => {
      this.assertOnline(null);
      if (value) {
        await this.controller.stop();
      }
    });

    this.setUpSensors(accessory, shutter);
  }

  private setUpSensors(accessory: PlatformAccessory, shutter: Shutter): void {
    const { Service } = this.platform;
    const has = (code: string): boolean => shutter.services.includes(code);
    const enabled = (kind: SensorKind, capable: boolean): boolean =>
      this.platform.sensorOverride(shutter, kind) ?? (this.platform.exposeSensors && capable);

    const ensure = (
      type: typeof Service.TemperatureSensor,
      subtype: string,
      label: string,
    ): Service =>
      accessory.getServiceById(type, subtype) ?? accessory.addService(type, label, subtype);

    const drop = (type: typeof Service.TemperatureSensor, subtype: string): void => {
      const existing = accessory.getServiceById(type, subtype);
      if (existing) {
        accessory.removeService(existing);
      }
    };

    if (enabled('temperature', has('S2'))) {
      this.tempService = ensure(Service.TemperatureSensor, 'temp', `${shutter.name} Temperature`);
    } else {
      drop(Service.TemperatureSensor, 'temp');
    }
    if (enabled('humidity', has('S2'))) {
      this.humService = ensure(Service.HumiditySensor, 'hum', `${shutter.name} Humidity`);
    } else {
      drop(Service.HumiditySensor, 'hum');
    }
    if (enabled('airQuality', has('S2'))) {
      this.airService = ensure(Service.AirQualitySensor, 'aq', `${shutter.name} Air Quality`);
    } else {
      drop(Service.AirQualitySensor, 'aq');
    }
    if (enabled('co2', has('S7'))) {
      this.co2Service = ensure(Service.CarbonDioxideSensor, 'co2', `${shutter.name} CO2`);
    } else {
      drop(Service.CarbonDioxideSensor, 'co2');
    }

    const { Characteristic } = this.platform;
    this.channels.length = 0;
    const track = (
      service: Service | undefined,
      characteristic: CharacteristicRef,
      metric: keyof StateReadings,
    ): void => {
      if (service) {
        this.channels.push({ service, characteristic, metric });
      }
    };
    track(this.tempService, Characteristic.CurrentTemperature, 'temperatureC');
    track(this.humService, Characteristic.CurrentRelativeHumidity, 'humidity');
    track(this.airService, Characteristic.AirQuality, 'iaq');
    track(this.co2Service, Characteristic.CarbonDioxideLevel, 'co2Ppm');

    // Seed from the last persisted readings (like the app's local cache);
    // otherwise show "No Response" until a real reading arrives.
    const staleMs = this.platform.sensorStaleMs;
    const cache = this.readingCache();
    const now = Date.now();
    for (const channel of this.channels) {
      const cached = cache[channel.metric];
      if (cached && (staleMs <= 0 || now - cached.ts <= staleMs)) {
        this.applyReading(channel.metric, cached.value, cached.ts);
      } else {
        channel.service.updateCharacteristic(channel.characteristic, this.noResponse());
      }
    }

    this.platform.log.info(
      `Sensors for ${shutter.name} [services=${shutter.services.join(',') || 'none'}]: ` +
        `airQuality=${!!this.airService} temperature=${!!this.tempService} ` +
        `humidity=${!!this.humService} co2=${!!this.co2Service}`,
    );

    if (staleMs > 0 && this.channels.length > 0) {
      setInterval(() => this.markStaleSensors(staleMs), 60_000).unref?.();
    }
  }

  private readingCache(): Record<string, { value: number; ts: number }> {
    const cache = this.accessory.context.sensors as
      Record<string, { value: number; ts: number }> | undefined;
    return cache && typeof cache === 'object' ? cache : {};
  }

  private markStaleSensors(staleMs: number): void {
    const now = Date.now();
    for (const channel of this.channels) {
      const last = this.lastReading.get(channel.metric);
      if (last === undefined || now - last > staleMs) {
        channel.service.updateCharacteristic(channel.characteristic, this.noResponse());
      }
    }
  }

  /** Feed device-reported readings (from the MQTT state subscription). */
  report(readings: StateReadings): void {
    this.platform.log.debug(`report ${JSON.stringify(readings)}`);
    this.setReachable(true); // any state push is proof of life
    if (readings.position !== undefined) {
      this.controller.onReported(readings.position);
    }
    this.updateSensors(readings);
  }

  private updateSensors(readings: StateReadings): void {
    const now = Date.now();
    if (readings.temperatureC !== undefined) {
      this.applyReading('temperatureC', readings.temperatureC, now);
    }
    if (readings.humidity !== undefined) {
      this.applyReading('humidity', readings.humidity, now);
    }
    if (readings.iaq !== undefined) {
      this.applyReading('iaq', readings.iaq, now);
    }
    if (readings.co2Ppm !== undefined) {
      this.applyReading('co2Ppm', readings.co2Ppm, now);
    }
  }

  /** Push one reading to its HomeKit characteristic and persist it for restart. */
  private applyReading(metric: keyof StateReadings, value: number, ts: number): void {
    const { Characteristic } = this.platform;
    switch (metric) {
      case 'temperatureC':
        if (!this.tempService) return;
        this.tempService.updateCharacteristic(
          Characteristic.CurrentTemperature,
          Math.max(-270, Math.min(100, value)),
        );
        break;
      case 'humidity':
        if (!this.humService) return;
        this.humService.updateCharacteristic(
          Characteristic.CurrentRelativeHumidity,
          Math.max(0, Math.min(100, value)),
        );
        break;
      case 'iaq':
        if (!this.airService) return;
        this.airService.updateCharacteristic(Characteristic.AirQuality, iaqToAirQuality(value));
        break;
      case 'co2Ppm':
        if (!this.co2Service) return;
        this.co2Service.updateCharacteristic(Characteristic.CarbonDioxideLevel, value);
        this.co2Service.updateCharacteristic(
          Characteristic.CarbonDioxideDetected,
          co2Detected(value),
        );
        break;
      default:
        return;
    }
    this.lastReading.set(metric, ts);
    const cache = this.readingCache();
    cache[metric] = { value, ts };
    this.accessory.context.sensors = cache;
  }

  /** Mark the accessory reachable/unreachable; offline shows as "No Response". */
  setReachable(online: boolean): void {
    if (online === this.online) {
      return;
    }
    this.online = online;
    const { Characteristic } = this.platform;
    if (online) {
      this.service.updateCharacteristic(
        Characteristic.CurrentPosition,
        this.controller.getCurrentPosition(),
      );
    } else {
      this.service.updateCharacteristic(Characteristic.CurrentPosition, this.noResponse());
    }
  }

  /** Return `value` when online, otherwise throw so HomeKit shows "No Response". */
  private assertOnline<T>(value: T): T {
    if (!this.online) {
      throw this.noResponse();
    }
    return value;
  }

  private noResponse(): Error {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    return new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }
}
