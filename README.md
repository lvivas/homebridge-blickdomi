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

| Option              | Required | Default | Description                                                   |
| ------------------- | -------- | ------- | ------------------------------------------------------------- |
| `username`          | yes      | —       | Your mySmartWindow account email.                             |
| `password`          | yes      | —       | Your account password (stored in `config.json` in cleartext). |
| `port`              | no       | 22222   | API port.                                                     |
| `fullTravelSeconds` | no       | 20      | Full open↔close travel time; smooths the position estimate.   |

## Behaviour notes

- **Initial position** is unknown until a shutter next moves — the device only
  reports after it moves, not on request. The first move (from HomeKit or the
  app) syncs it; the last-known position is remembered across restarts.
- **Position scale** is handled internally: the device uses a percent-closed
  value, inverted from HomeKit, and its fully-closed value exceeds 100, so a full
  close is sent as a discrete "down" rather than a position target.

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
