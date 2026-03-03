# nr-mqtt Architecture

nr-mqtt is a Docker Compose application that bridges MQTT telemetry from
Particle Photon devices to the New Relic Event API.

See `README.md` for setup, configuration, and operational runbook.

---

## Services

Two services defined in `docker-compose.yml`:

- **mosquitto** — `eclipse-mosquitto:2` broker. Plain TCP on port 1883 (LAN
  only). Anonymous access disabled; all clients authenticate via
  `mosquitto/config/passwd`. See `mosquitto/config/mosquitto.conf`.

- **relay** — Node.js 20 service (`relay/Dockerfile`). Waits for mosquitto
  to pass its health check before starting.

---

## Relay Design

### Logic flow (`relay/index.js`)

```
startup
  validate required env vars, exit 1 if missing
  connect to Mosquitto (MQTT_BROKER_URL, username, password)
  subscribe to geeforce/+/accel and geeforce/+/status (QoS 0)
  start flush timer (BATCH_INTERVAL_MS, default 2000ms)
  start HTTP health server on :3000

on MQTT message (topic, payload)
  parse JSON payload
  set eventType = "AccelSample" or "DeviceStatus" based on topic suffix
  map short fields to NR event fields (see README § New Relic Event Schema)
  push mapped event to pendingBatch[]
  if pendingBatch.length >= BATCH_SIZE: flushBatch()

flushBatch()
  if pendingBatch is empty: return
  snapshot = pendingBatch.splice(0)       // drain atomically
  POST snapshot to NR Event API (up to 3 retries, 1s delay)
  log result

NR Event API call
  POST https://insights-collector.newrelic.com/v1/accounts/{accountId}/events
  Headers: Content-Type: application/json, X-Insert-Key: {NEW_RELIC_INSERT_KEY}
  Body: JSON.stringify(snapshotArray)

health server GET /health
  200 OK  {"status":"ok","pending":N,"mqttConnected":true}
  503     if MQTT is disconnected
```

### Batching behaviour

| Condition                         | Action                            |
|-----------------------------------|-----------------------------------|
| `pendingBatch.length >= BATCH_SIZE` | Flush immediately               |
| Timer fires (BATCH_INTERVAL_MS)   | Flush if batch non-empty          |
| POST fails, attempt ≤ 3           | Retry with 1s delay               |
| POST fails, attempt > 3           | Discard batch, log error          |

At 3 Hz per device the default 2-second window produces ~6 events per flush.
BATCH_SIZE (default 500) is a safety valve for burst scenarios.

---

## Security

- Port 1883 is plain TCP. The `hirotakaster/MQTT` Particle library does not
  support TLS, so TLS is intentionally omitted. Restrict port 1883 to the
  local LAN via firewall; do not expose it to the internet.
- The relay uses a dedicated MQTT credential (`nr-relay`) separate from device
  credentials, limiting blast radius if one is compromised.
- The New Relic Insert Key is injected via environment variable and never
  written inside the container or transmitted over MQTT.
- Rotate credentials by updating `.env` and `mosquitto/config/passwd`, then
  running `docker compose restart`.

---

## Health Checks

**mosquitto** — Docker Compose subscribes to `$SYS/#` and waits for one
message. Mosquitto publishes `$SYS` every 10 s; a successful receive confirms
the broker accepts connections.

**relay** — `GET /health` on port 3000 (internal only). Returns 200 when MQTT
is connected, 503 otherwise. `depends_on: condition: service_healthy` prevents
the relay from starting before the broker is ready.
