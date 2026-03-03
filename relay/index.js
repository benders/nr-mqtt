'use strict';

const mqtt = require('mqtt');

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------
const config = {
  mqttBrokerUrl: process.env.MQTT_BROKER_URL || 'mqtt://mosquitto:1883',
  mqttUsername: process.env.MQTT_USERNAME || 'nr-relay',
  mqttPassword: process.env.MQTT_PASSWORD || '',
  nrAccountId: process.env.NEW_RELIC_ACCOUNT_ID || '',
  nrInsertKey: process.env.NEW_RELIC_INSERT_KEY || '',
  batchSize: parseInt(process.env.BATCH_SIZE || '500', 10),
  batchIntervalMs: parseInt(process.env.BATCH_INTERVAL_MS || '2000', 10),
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
};

// ---------------------------------------------------------------------------
// Structured logger (JSON lines to stdout)
// ---------------------------------------------------------------------------
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLogLevel = LOG_LEVELS[config.logLevel] ?? LOG_LEVELS.info;

function log(level, msg, extra = {}) {
  if ((LOG_LEVELS[level] ?? 0) < currentLogLevel) return;
  const entry = { ts: new Date().toISOString(), level, msg, ...extra };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

// ---------------------------------------------------------------------------
// Validate required config
// ---------------------------------------------------------------------------
if (!config.nrAccountId) {
  log('error', 'NEW_RELIC_ACCOUNT_ID is not set');
  process.exit(1);
}
if (!config.nrInsertKey) {
  log('error', 'NEW_RELIC_INSERT_KEY is not set');
  process.exit(1);
}

const NR_EVENTS_URL = `https://insights-collector.newrelic.com/v1/accounts/${config.nrAccountId}/events`;

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------
const counters = {
  messagesReceived: 0,
  eventsBuffered: 0,
  batchesSent: 0,
  eventsForwarded: 0,
  nrErrors: 0,
  parseErrors: 0,
};

// ---------------------------------------------------------------------------
// Event buffer
// ---------------------------------------------------------------------------
let eventBuffer = [];

// ---------------------------------------------------------------------------
// Map compact accel fields to full New Relic event schema
// ---------------------------------------------------------------------------
function mapAccelEvent(raw, deviceIdFromTopic) {
  // Validate required compact fields
  if (raw.ts === undefined || raw.x === undefined || raw.y === undefined ||
      raw.z === undefined || raw.m === undefined) {
    throw new Error(`missing required accel fields: ${JSON.stringify(raw)}`);
  }

  return {
    eventType: 'AccelSample',
    timestamp: raw.ts,   // NR uses millisecond epoch for eventTimestamp; keep ts too
    ts: raw.ts,
    accelX: raw.x,
    accelY: raw.y,
    accelZ: raw.z,
    magnitude: raw.m,
    deviceId: raw.dev || deviceIdFromTopic,
  };
}

// ---------------------------------------------------------------------------
// Map status fields to DeviceStatus event
// ---------------------------------------------------------------------------
function mapStatusEvent(raw, deviceIdFromTopic) {
  return {
    eventType: 'DeviceStatus',
    timestamp: raw.ts || Date.now(),
    deviceId: raw.dev || deviceIdFromTopic,
    uptime: raw.uptime,
    rssi: raw.rssi,
  };
}

// ---------------------------------------------------------------------------
// Post a batch to New Relic Event API
// Returns true on success, false on failure.
// ---------------------------------------------------------------------------
async function postToNewRelic(events) {
  const body = JSON.stringify(events);
  const res = await fetch(NR_EVENTS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Insert-Key': config.nrInsertKey,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`NR API responded ${res.status}: ${text}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Flush the current buffer to New Relic
// Takes a snapshot of the buffer, clears it, then attempts to send.
// On first failure: retries once. On second failure: drops batch and logs.
// ---------------------------------------------------------------------------
async function flushBatch(events) {
  if (events.length === 0) return;

  log('debug', 'flushing batch', { count: events.length });

  try {
    await postToNewRelic(events);
    counters.batchesSent += 1;
    counters.eventsForwarded += events.length;
    log('info', 'batch sent', { count: events.length, batchesSent: counters.batchesSent });
  } catch (err) {
    log('warn', 'first NR send attempt failed, retrying', { error: err.message });
    try {
      await postToNewRelic(events);
      counters.batchesSent += 1;
      counters.eventsForwarded += events.length;
      log('info', 'batch sent on retry', { count: events.length });
    } catch (retryErr) {
      counters.nrErrors += 1;
      log('error', 'batch dropped after retry failure', {
        count: events.length,
        error: retryErr.message,
        nrErrors: counters.nrErrors,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Drain the buffer: take a snapshot, clear the live buffer, then flush.
// This ensures new events arriving during an in-flight HTTP call are not lost.
// ---------------------------------------------------------------------------
async function drainBuffer() {
  if (eventBuffer.length === 0) return;
  const snapshot = eventBuffer;
  eventBuffer = [];
  await flushBatch(snapshot);
}

// ---------------------------------------------------------------------------
// MQTT client setup
// ---------------------------------------------------------------------------
const client = mqtt.connect(config.mqttBrokerUrl, {
  clientId: `nr-relay-${process.pid}`,
  username: config.mqttUsername,
  password: config.mqttPassword,
  clean: true,
  reconnectPeriod: 5000,       // retry every 5s on disconnect
  connectTimeout: 15000,
  keepalive: 60,
});

client.on('connect', () => {
  log('info', 'connected to MQTT broker', { url: config.mqttBrokerUrl });

  client.subscribe('geeforce/+/accel', { qos: 0 }, (err) => {
    if (err) {
      log('error', 'failed to subscribe to accel topic', { error: err.message });
    } else {
      log('info', 'subscribed', { topic: 'geeforce/+/accel' });
    }
  });

  client.subscribe('geeforce/+/status', { qos: 0 }, (err) => {
    if (err) {
      log('error', 'failed to subscribe to status topic', { error: err.message });
    } else {
      log('info', 'subscribed', { topic: 'geeforce/+/status' });
    }
  });
});

client.on('reconnect', () => {
  log('warn', 'reconnecting to MQTT broker');
});

client.on('offline', () => {
  log('warn', 'MQTT client offline');
});

client.on('error', (err) => {
  log('error', 'MQTT client error', { error: err.message });
});

client.on('message', (topic, payload) => {
  counters.messagesReceived += 1;

  // Extract device ID from topic: geeforce/<deviceId>/accel|status
  const topicParts = topic.split('/');
  const deviceIdFromTopic = topicParts[1] || 'unknown';
  const messageType = topicParts[2];

  let raw;
  try {
    raw = JSON.parse(payload.toString());
  } catch (parseErr) {
    counters.parseErrors += 1;
    log('warn', 'failed to parse message JSON', {
      topic,
      error: parseErr.message,
      payload: payload.toString().slice(0, 200),
    });
    return;
  }

  let event;
  try {
    if (messageType === 'accel') {
      event = mapAccelEvent(raw, deviceIdFromTopic);
    } else if (messageType === 'status') {
      event = mapStatusEvent(raw, deviceIdFromTopic);
    } else {
      log('debug', 'ignoring unknown topic type', { topic });
      return;
    }
  } catch (mapErr) {
    counters.parseErrors += 1;
    log('warn', 'failed to map event fields', { topic, error: mapErr.message });
    return;
  }

  eventBuffer.push(event);
  counters.eventsBuffered += 1;

  log('debug', 'event buffered', {
    topic,
    eventType: event.eventType,
    bufferSize: eventBuffer.length,
  });

  // Flush immediately if we hit the batch size limit
  if (eventBuffer.length >= config.batchSize) {
    log('info', 'batch size limit reached, flushing', { batchSize: config.batchSize });
    drainBuffer().catch((err) => {
      log('error', 'unexpected drain error', { error: err.message });
    });
  }
});

// ---------------------------------------------------------------------------
// Periodic flush by time window
// ---------------------------------------------------------------------------
const flushTimer = setInterval(() => {
  drainBuffer().catch((err) => {
    log('error', 'unexpected periodic drain error', { error: err.message });
  });
}, config.batchIntervalMs);

// Keep the timer from preventing process exit during graceful shutdown
flushTimer.unref();

// ---------------------------------------------------------------------------
// Periodic stats log (every 60s at info level)
// ---------------------------------------------------------------------------
const statsTimer = setInterval(() => {
  log('info', 'relay stats', { ...counters });
}, 60_000);
statsTimer.unref();

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  log('info', 'shutting down', { signal });

  clearInterval(flushTimer);
  clearInterval(statsTimer);

  // Stop receiving new messages
  client.end(false, {}, async () => {
    // Flush anything remaining in the buffer
    try {
      await drainBuffer();
    } catch (err) {
      log('error', 'error flushing on shutdown', { error: err.message });
    }
    log('info', 'shutdown complete', { ...counters });
    process.exit(0);
  });

  // Force exit after 10s if graceful shutdown hangs
  setTimeout(() => {
    log('warn', 'forced exit after shutdown timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

log('info', 'nr-mqtt-relay starting', {
  mqttBrokerUrl: config.mqttBrokerUrl,
  mqttUsername: config.mqttUsername,
  nrAccountId: config.nrAccountId,
  batchSize: config.batchSize,
  batchIntervalMs: config.batchIntervalMs,
  logLevel: config.logLevel,
});
