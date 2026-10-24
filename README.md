# homebridge-blickdomi

A [Homebridge](https://homebridge.io) plugin that exposes **Blickdomi** window
shutters (by Solven) to HomeKit as `WindowCovering` accessories.

Developed and tested with the Blickdomi **Sentry** shutter. Other Blickdomi
shutters that use the same mySmartWindow app may work but are untested.

> Unofficial. Not affiliated with, endorsed by, or supported by Solven or
> Blickdomi. It talks to the mySmartWindow cloud using **your own account**, so
> it depends on that service and may break if their API changes. Use at your own
> risk.

## How it works

These shutters expose no usable local control API, so the plugin uses the same
cloud paths the official app does:

- **Auth & discovery** — a REST login to mySmartWindow returns a bearer token,
  then the list of homes / rooms / windows.
- **Control** — movement commands are published over **AWS IoT** (MQTT), using
  short-lived credentials vended by the API. Up / down / stop / set-position map
  to device ops.
- **Live state** — the device publishes its position to an MQTT topic whenever it
  settles; the plugin subscribes and updates HomeKit in real time. Credentials
  are refreshed in place so the single connection stays up.
- **Sensors** — shutters with the air-quality module (e.g. Sentry) also report
  air quality (IAQ), CO₂, temperature and humidity on the same subscription,
  exposed as the matching HomeKit sensors. Each can be toggled per device.

There is no local-network control path; everything routes through the vendor
cloud.

## Install

Requires **Node 18+** and Homebridge 1.8+.

```bash
npm install -g homebridge-blickdomi
```

Or build a tarball from source and install it on the Homebridge host:

```bash
npm install && npm run build && npm pack
# copy the .tgz across, then:
sudo npm install -g ./homebridge-blickdomi-<version>.tgz
```

## Configuration

Add the platform via the Homebridge UI (a settings form is provided) or in
`config.json`:

```json
{
  "platforms": [
    {
      "platform": "Blickdomi",
      "name": "Blickdomi",
      "username": "you@example.com",
      "password": "your-account-password",
      "fullTravelSeconds": 20
    }
  ]
}
```

| Option                    | Required | Default | Description                                                                 |
| ------------------------- | -------- | ------- | --------------------------------------------------------------------------- |
| `username`                | yes      | —       | Your mySmartWindow account email.                                           |
| `password`                | yes      | —       | Your account password (stored in `config.json` in cleartext).               |
| `port`                    | no       | 22222   | API port.                                                                   |
| `fullTravelSeconds`       | no       | 20      | Full open↔close travel time; smooths the position estimate.                 |
| `exposeSensors`           | no       | true    | Expose air-quality/CO₂/temperature/humidity sensors on capable shutters.    |
| `sensorStaleMinutes`      | no       | 0       | If > 0, show a sensor as No Response when it hasn't reported for this long. |
| `enableReachability`      | no       | false   | Mark unreachable shutters as "No Response" (experimental).                  |
| `reachabilityPollSeconds` | no       | 180     | How often to check reachability (only when enableReachability).             |
| `offlineStaleMinutes`     | no       | 0       | If > 0, also treat a shutter offline when its last contact is this stale.   |
| `devices`                 | no       | —       | Per-device sensor on/off overrides (see below).                             |

### Sensors

On by default for shutters that have the module (e.g. Sentry). The device
publishes readings on its own every few minutes (temperature, humidity, CO₂, VOC,
IAQ). Each sensor shows **No Response** until its first reading arrives, so a
sensor the device never reports stays clearly non-responsive instead of showing a
fake 0. The last readings are remembered across Homebridge restarts and shown
immediately on startup (the cloud has no fetchable sensor values, so this mirrors
how the app caches). Set `sensorStaleMinutes` to also revert a sensor to No
Response if it stops reporting (keep it generous — readings are only every few
minutes).

Set `exposeSensors: false` to disable sensors globally, or force a sensor on/off
for a specific shutter with a `devices` entry (matched by name or window id),
which overrides `exposeSensors`:

```json
"devices": [
  { "name": "Bedroom", "airQuality": false, "co2": false },
  { "name": "Kitchen", "temperature": true, "humidity": true }
]
```

## Behaviour notes

- **Initial position** is unknown until a shutter next moves — the device only
  reports after it moves, not on request. The first move (from HomeKit or the
  app) syncs it; the last-known position is remembered across restarts.
- **Position scale** is handled internally: the device uses a percent-closed
  value, inverted from HomeKit, and its fully-closed value exceeds 100, so a full
  close is sent as a discrete "down" rather than a position target.
- **Offline shutters** show as **No Response** in HomeKit instead of silently
  accepting commands that go nowhere. Reachability comes from the cloud's
  `Active` flag, polled periodically; a live state push also marks a shutter back
  online. The optional `offlineStaleMinutes` adds a last-contact check — leave it
  off (0) unless you have confirmed your shutters report in regularly, otherwise
  an idle shutter could be shown offline.
- **Air quality** maps the device's IAQ index to HomeKit's 1–5 scale
  (0–50 Excellent … >200 Poor); CO₂ is reported in ppm (detected above 1000);
  temperature (°C) and humidity (%) are passed through. VOC is reported in ppm by
  the device; it is not exposed as HomeKit `VOCDensity` (µg/m³) because the
  conversion needs an arbitrary molar-mass assumption.

## Development

```bash
npm install
npm run check   # eslint + prettier --check + vitest + tsc build
```

Architecture: `src/client` holds the `BlickdomiClient` interface and its cloud
implementation (REST + AWS IoT); `src/control` holds HAP-free control logic;
`src/platform.ts` and `src/accessory.ts` map each shutter to a WindowCovering.
The control logic and HTTP/MQTT seams are unit-tested against mocks.

## License

MIT — see [LICENSE](LICENSE).
