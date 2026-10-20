import type { PlatformAccessory, Service } from 'homebridge';

import type { BlickdomiPlatform } from './platform';
import type { Shutter } from './client/types';
import { ShutterController } from './control/shutterController';

/** Binds one shutter's WindowCovering service to a {@link ShutterController}. */
export class ShutterAccessory {
  private readonly service: Service;
  private readonly controller: ShutterController;

  constructor(
    private readonly platform: BlickdomiPlatform,
    accessory: PlatformAccessory,
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
      .onGet(() => this.controller.getCurrentPosition());

    this.service
      .getCharacteristic(Characteristic.PositionState)
      .onGet(() => this.controller.getPositionState());

    this.service
      .getCharacteristic(Characteristic.TargetPosition)
      .onGet(() => this.controller.getTargetPosition())
      .onSet(async (value) => {
        await this.controller.setTarget(Number(value));
      });

    this.service.getCharacteristic(Characteristic.HoldPosition).onSet(async (value) => {
      if (value) {
        await this.controller.stop();
      }
    });
  }

  /** Feed a device-reported position (from the MQTT state subscription). */
  report(position: number): void {
    this.controller.onReported(position);
  }
}
