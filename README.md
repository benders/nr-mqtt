# nr-mqtt

MQTT broker + New Relic relay for gee-force rocket telemetry.

Receives accelerometer samples from a Particle Photon over MQTT and forwards
them in batches to the New Relic Event API.

---

## Prerequisites

- Docker >= 24
- Docker Compose v2 (`docker compose` subcommand, not `docker-compose`)
- A New Relic account with an Insert Key (Ingest - License key or classic Insert key)

---

## Quick Start

### 1. Clone and configure

```bash
git clone <this-repo> nr-mqtt
cd nr-mqtt
cp .env.example .env
```

Edit `.env` and fill in your New Relic credentials:

```
NEW_RELIC_ACCOUNT_ID=1234567
NEW_RELIC_INSERT_KEY=NRII-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Leave the other values at their defaults or tune as needed.

### 2. Create MQTT credentials

Both the device and the relay need a password in Mosquitto's password file.
The script handles this whether or not the container is already running.

```bash
# Create the relay credential first (used by the relay service)
./scripts/add-device.sh nr-relay change-me-relay

# Create the device credential (used by the Particle Photon firmware)
./scripts/add-device.sh geeforce-device change-me-device
```

The passwords you set here must match:
- `MQTT_PASSWORD` in `.env` for the relay user
- The password configured in your Particle firmware for the device user

### 3. Start services

```bash
docker compose up -d
```

Verify both services are running:

```bash
docker compose ps
```

### 4. Verify data arrives in New Relic

Run this NRQL query in the New Relic query builder:

```sql
SELECT * FROM AccelSample SINCE 10 minutes ago LIMIT 20
```

Or for device heartbeats:

```sql
SELECT * FROM DeviceStatus SINCE 10 minutes ago LIMIT 20
```

---

## Security Notes

### No TLS

TLS is intentionally disabled. The Particle Photon MQTT library (`MQTT` by
hirotakaster) does not support TLS. All traffic between the Photon and the
broker is unencrypted plaintext.

**Recommendation**: Deploy this stack on a LAN-only host that the Particle
device can reach directly (e.g., a Raspberry Pi on the same Wi-Fi network).
Do not expose port 1883 to the public internet.

### Adding TLS (future)

If you switch to a device that supports TLS (e.g., Particle Boron with a
TLS-capable MQTT library):

1. Generate or obtain a certificate (e.g., via Let's Encrypt or a self-signed CA).
2. Add `listener 8883` and TLS directives to `mosquitto/config/mosquitto.conf`.
3. Mount the cert/key into the mosquitto container.
4. Update `MQTT_BROKER_URL` in `.env` to `mqtts://mosquitto:8883`.
5. Configure the device firmware to trust the CA certificate.

### Credentials

- MQTT passwords live in `mosquitto/config/passwd` (gitignored).
- The New Relic Insert Key lives only in `.env` (gitignored).
- Neither is ever sent to the MQTT broker or stored in firmware.

### Anonymous access

`allow_anonymous false` is set in `mosquitto.conf`. Every client must
authenticate with a username and password.

---

## MQTT Topic Structure

| Topic                    | Direction       | Description                    |
|--------------------------|-----------------|--------------------------------|
| `geeforce/<id>/accel`    | device → broker | Accelerometer sample           |
| `geeforce/<id>/status`   | device → broker | Device heartbeat / status      |

### Accel message format

```json
{"ts":1234567890123,"x":0.123,"y":0.456,"z":0.789,"m":0.935,"dev":"abc123"}
```

| Field | Type   | Description                        |
|-------|--------|------------------------------------|
| `ts`  | number | Unix timestamp, milliseconds        |
| `x`   | number | X-axis acceleration (g)            |
| `y`   | number | Y-axis acceleration (g)            |
| `z`   | number | Z-axis acceleration (g)            |
| `m`   | number | Magnitude (g)                      |
| `dev` | string | Device ID                          |

### Status message format

```json
{"ts":1234567890123,"dev":"abc123","uptime":3600,"rssi":-65}
```

---

## New Relic Event Schema

### AccelSample

| NR Field    | Source field | Description                  |
|-------------|--------------|------------------------------|
| `eventType` | (relay adds) | `"AccelSample"`              |
| `timestamp` | `ts`         | Unix ms epoch                |
| `accelX`    | `x`          | X-axis acceleration (g)      |
| `accelY`    | `y`          | Y-axis acceleration (g)      |
| `accelZ`    | `z`          | Z-axis acceleration (g)      |
| `magnitude` | `m`          | Vector magnitude (g)         |
| `deviceId`  | `dev`        | Device identifier            |

### DeviceStatus

| NR Field    | Source field | Description                  |
|-------------|--------------|------------------------------|
| `eventType` | (relay adds) | `"DeviceStatus"`             |
| `timestamp` | `ts`         | Unix ms epoch                |
| `deviceId`  | `dev`        | Device identifier            |
| `uptime`    | `uptime`     | Uptime in seconds            |
| `rssi`      | `rssi`       | Wi-Fi RSSI (dBm)             |

---

## Environment Variables

| Variable              | Default                     | Description                                      |
|-----------------------|-----------------------------|--------------------------------------------------|
| `NEW_RELIC_ACCOUNT_ID`| (required)                  | New Relic account ID                             |
| `NEW_RELIC_INSERT_KEY`| (required)                  | New Relic ingest/insert key                      |
| `MQTT_BROKER_URL`     | `mqtt://mosquitto:1883`     | MQTT broker URL (relay → broker)                 |
| `MQTT_USERNAME`       | `nr-relay`                  | MQTT username for relay service                  |
| `MQTT_PASSWORD`       | (required)                  | MQTT password for relay service                  |
| `BATCH_SIZE`          | `500`                       | Max events per NR API call                       |
| `BATCH_INTERVAL_MS`   | `2000`                      | Max ms between NR API calls                      |
| `LOG_LEVEL`           | `info`                      | Log verbosity: `debug`, `info`, `warn`, `error`  |

---

## Monitoring

### Relay logs

```bash
docker compose logs -f relay
```

The relay emits structured JSON log lines. Each line has at minimum:
`{"ts":"...","level":"info","msg":"..."}`.

Key log messages:

| Message                  | Meaning                                         |
|--------------------------|-------------------------------------------------|
| `connected to MQTT broker` | Relay successfully authenticated to Mosquitto |
| `batch sent`             | Events delivered to New Relic                   |
| `batch dropped after retry failure` | NR API unreachable; events lost       |
| `relay stats`            | Periodic counter dump (every 60s)               |

### Mosquitto logs

```bash
docker compose logs -f mosquitto
```

Or view the persistent log file:

```bash
docker compose exec mosquitto cat /mosquitto/log/mosquitto.log
```

### Adding a new device

```bash
./scripts/add-device.sh <username> <password>
```

Re-run with the same username to rotate a password.

---

## Stopping

```bash
docker compose down
```

To also remove persistent volumes (clears all Mosquitto state):

```bash
docker compose down -v
```
