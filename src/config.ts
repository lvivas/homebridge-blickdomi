import type { PlatformConfig } from 'homebridge';

/** Per-device sensor overrides; unset = auto (exposed when the device supports it). */
export interface DeviceConfig {
  /** Match by shutter name or window id. */
  name?: string;
  airQuality?: boolean;
  temperature?: boolean;
  humidity?: boolean;
  co2?: boolean;
  /** °C added to the temperature reading; humidity is corrected to match. */
  temperatureOffset?: number;
}

export type SensorKind = 'airQuality' | 'temperature' | 'humidity' | 'co2';

export interface BlickdomiPlatformConfig extends PlatformConfig {
  username?: string;
  password?: string;
  port?: number;
  /** Seconds for a full open↔close travel; drives optimistic position. */
  fullTravelSeconds?: number;
  /** Mark unreachable shutters as "No Response" (experimental; default off). */
  enableReachability?: boolean;
  /** Master switch for all sensors (default on). */
  exposeSensors?: boolean;
  /** Global per-sensor switches (each default on); per-device `devices` overrides win. */
  exposeAirQuality?: boolean;
  exposeCo2?: boolean;
  exposeTemperature?: boolean;
  exposeHumidity?: boolean;
  /** °C added to every shutter's temperature (humidity corrected to match). */
  temperatureOffset?: number;
  /** How often to poll window reachability (seconds). */
  reachabilityPollSeconds?: number;
  /** If > 0, treat a window offline when Last_Connection is this many minutes old. */
  offlineStaleMinutes?: number;
  /** Per-device sensor on/off overrides. */
  devices?: DeviceConfig[];
}
