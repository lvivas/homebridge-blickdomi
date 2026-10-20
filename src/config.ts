import type { PlatformConfig } from 'homebridge';

export interface BlickdomiPlatformConfig extends PlatformConfig {
  username?: string;
  password?: string;
  port?: number;
  /** Seconds for a full open↔close travel; drives optimistic position. */
  fullTravelSeconds?: number;
}
