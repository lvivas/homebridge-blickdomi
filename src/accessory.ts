import type { PlatformAccessory, Service } from 'homebridge';

import type { BlickdomiPlatform } from './platform';
import type { SensorKind } from './config';
import type { Shutter, StateReadings } from './client/types';
import { co2Detected, iaqToAirQuality } from './control/airquality';
import { ShutterController } from './control/shutterController';

/** Binds one shutter's WindowCovering and its optional sensor services. */
export class ShutterAccessory {
  private readonly service: Service;
  private readonly controller: ShutterController;
  private online = true;
  private airService?: Service;
  private tempService?: Service;
  private humService?: Service;
  private co2Service?: Service;

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

    // Seed from the last persisted readings (like the app's local cache). No
    // "No Response" for not-yet-seen metrics: a sensor in No Response alongside
    // the responding shutter makes HomeKit flap the whole accessory.
    const cache = this.readingCache();
    for (const metric of Object.keys(cache) as (keyof StateReadings)[]) {
      this.applyReading(metric, cache[metric]);
    }

    this.platform.log.info(
      `Sensors for ${shutter.name} [services=${shutter.services.join(',') || 'none'}]: ` +
        `airQuality=${!!this.airService} temperature=${!!this.tempService} ` +
        `humidity=${!!this.humService} co2=${!!this.co2Service}`,
    );
  }

  private readingCache(): Partial<Record<keyof StateReadings, number>> {
    const cache = this.accessory.context.sensors as
      Partial<Record<keyof StateReadings, number>> | undefined;
    return cache && typeof cache === 'object' ? cache : {};
  }

  /** Feed device-reported readings (from the MQTT state subscription). */
  report(readings: StateReadings): void {
    this.setReachable(true); // any state push is proof of life
    if (readings.position !== undefined) {
      this.controller.onReported(readings.position);
    }
    if (readings.temperatureC !== undefined) {
      this.applyReading('temperatureC', readings.temperatureC);
    }
    if (readings.humidity !== undefined) {
      this.applyReading('humidity', readings.humidity);
    }
    if (readings.iaq !== undefined) {
      this.applyReading('iaq', readings.iaq);
    }
    if (readings.co2Ppm !== undefined) {
      this.applyReading('co2Ppm', readings.co2Ppm);
    }
  }

  /** Push one reading to its HomeKit characteristic and persist it for restart. */
  private applyReading(metric: keyof StateReadings, value: number | undefined): void {
    if (value === undefined) {
      return;
    }
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
    const cache = this.readingCache();
    cache[metric] = value;
    this.accessory.context.sensors = cache;
  }

  /** Mark the covering reachable/unreachable; offline shows as "No Response". */
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
