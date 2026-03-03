# nr-mqtt

General-purpose MQTT to New Relic relay.

Subscribes to one or more MQTT topics, batches the messages, and forwards them
to the [New Relic Event API](https://docs.newrelic.com/docs/data-apis/ingest-apis/event-api/introduction-event-api/).

---

## How it works

Each MQTT message must be a JSON object. The relay passes the payload through
to New Relic as-is, with two rules applied:

1. **`eventType` is required.** Messages without an `eventType` field are
   dropped with a warning log.
2. **`timestamp` is inferred** from the MQTT receive time (epoch milliseconds)
   if the payload does not include it.

All other fields are forwarded exactly as received.

---

## Prerequisites

- Docker >= 24
- Docker Compose v2 (`docker compose` subcommand)
- A New Relic account with an Insert Key (Ingest - License key or classic Insert key)

---

## Quick Start

### 1. Configure

```bash
cp .env.example .env
```

Edit `.env` and fill in your New Relic credentials and MQTT settings:

```
NEW_RELIC_ACCOUNT_ID=1234567
NEW_RELIC_INSERT_KEY=NRII-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
MQTT_TOPICS=sensors/#,devices/+/status
```

### 2. Create MQTT credentials

```bash
# Create the relay credential (used by the relay service)
./scripts/add-device.sh nr-relay change-me-relay

# Create credentials for any devices that will publish
./scripts/add-device.sh my-device change-me-device
```

The password set for `nr-relay` must match `MQTT_PASSWORD` in `.env`.

### 3. Start

```bash
docker compose up -d
docker compose ps
```

### 4. Verify data in New Relic

Query whatever `eventType` your devices publish:

```sql
SELECT * FROM MySensorEvent SINCE 10 minutes ago LIMIT 20
```

---

## Message Format

Each MQTT message must be a valid JSON object. Example:

```json
{
  "eventType": "TemperatureSample",
  "timestamp": 1710000000000,
  "deviceId": "sensor-01",
  "tempC": 22.5,
  "humidity": 48.2
}
```

| Field       | Required | Notes                                                        |
|-------------|----------|--------------------------------------------------------------|
| `eventType` | **Yes**  | Determines the NR event table. Messages without it are dropped. |
| `timestamp` | No       | Epoch milliseconds. Inferred from receive time if absent.   |
| Everything else | No  | Forwarded as-is.                                             |

---

## Environment Variables

| Variable              | Default                   | Description                                           |
|-----------------------|---------------------------|-------------------------------------------------------|
| `NEW_RELIC_ACCOUNT_ID`| (required)                | New Relic account ID                                  |
| `NEW_RELIC_INSERT_KEY`| (required)                | New Relic ingest/insert key                           |
| `MQTT_BROKER_URL`     | `mqtt://mosquitto:1883`   | MQTT broker URL                                       |
| `MQTT_USERNAME`       | `nr-relay`                | MQTT username for relay service                       |
| `MQTT_PASSWORD`       | (required)                | MQTT password for relay service                       |
| `MQTT_TOPICS`         | `#`                       | Comma-separated list of topics to subscribe to        |
| `BATCH_SIZE`          | `500`                     | Max events per NR API call                            |
| `BATCH_INTERVAL_MS`   | `2000`                    | Max ms between NR API calls                           |
| `LOG_LEVEL`           | `info`                    | Log verbosity: `debug`, `info`, `warn`, `error`       |

---

## Security Notes

### No TLS

TLS is disabled by default. Do not expose port 1883 to the public internet.
Run this stack on a LAN-only host that your devices can reach directly.

To enable TLS, add a `listener 8883` block with TLS directives to
`mosquitto/config/mosquitto.conf`, mount certs into the container, and update
`MQTT_BROKER_URL` to `mqtts://mosquitto:8883`.

### Credentials

- MQTT passwords live in `mosquitto/config/passwd` (gitignored).
- The New Relic Insert Key lives only in `.env` (gitignored).

### Anonymous access

`allow_anonymous false` is set in `mosquitto.conf`. Every client must
authenticate.

---

## Monitoring

### Relay logs

```bash
docker compose logs -f relay
```

The relay emits structured JSON log lines. Key messages:

| Message                            | Meaning                                      |
|------------------------------------|----------------------------------------------|
| `connected to MQTT broker`         | Relay authenticated to Mosquitto             |
| `subscribed`                       | Topic subscription confirmed                 |
| `message dropped: missing eventType` | Payload had no `eventType`; discarded      |
| `batch sent`                       | Events delivered to New Relic               |
| `batch dropped after retry failure`| NR API unreachable; events lost             |
| `relay stats`                      | Periodic counter dump (every 60s)           |

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

Remove persistent volumes too:

```bash
docker compose down -v
```
