# nr-mqtt Architecture

nr-mqtt is a Docker Compose application that relays MQTT messages to the
New Relic Event API.

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
  subscribe to each topic in MQTT_TOPICS (QoS 0, default: #)
  start flush timer (BATCH_INTERVAL_MS, default 2000ms)

on MQTT message (topic, payload)
  record receivedAt = Date.now()
  parse JSON payload — drop with warning on parse error
  require eventType field — drop with warning if missing
  if timestamp absent: set timestamp = receivedAt
  push event to buffer (payload passed through as-is otherwise)
  if buffer.length >= BATCH_SIZE: drainBuffer()

drainBuffer()
  snapshot = buffer; buffer = []   // atomic drain
  POST snapshot to NR Event API (2 attempts, 1s delay on retry)
  log result

NR Event API call
  POST https://insights-collector.newrelic.com/v1/accounts/{accountId}/events
  Headers: Content-Type: application/json, X-Insert-Key: {NEW_RELIC_INSERT_KEY}
  Body: JSON.stringify(snapshotArray)
```

### Batching behaviour

| Condition                           | Action                          |
|-------------------------------------|---------------------------------|
| `buffer.length >= BATCH_SIZE`       | Flush immediately               |
| Timer fires (BATCH_INTERVAL_MS)     | Flush if buffer non-empty       |
| POST fails, first attempt           | Retry once after 1s             |
| POST fails after retry              | Discard batch, log error        |

---

## Security

- Port 1883 is plain TCP. Restrict it to the local LAN via firewall; do not
  expose it to the internet.
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

**relay** — `depends_on: condition: service_healthy` prevents the relay from
starting before the broker is ready. The relay logs connection and subscription
state at startup.
