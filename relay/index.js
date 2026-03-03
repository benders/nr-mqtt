'use strict';

const mqtt = require('mqtt');

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------
const config = {
  mqttBrokerUrl: process.env.MQTT_BROKER_URL || 'mqtt://mosquitto:1883',
  mqttUsername: process.env.MQTT_USERNAME || 'nr-relay',
  mqttPassword: process.env.MQTT_PASSWORD || '',
  mqttTopics: (process.env.MQTT_TOPICS || '#').split(',').map(t => t.trim()).filter(Boolean),
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
  droppedNoEventType: 0,
};

// ---------------------------------------------------------------------------
// Event buffer
// ---------------------------------------------------------------------------
let eventBuffer = [];

// ---------------------------------------------------------------------------
// Post a batch to New Relic Event API
// ---------------------------------------------------------------------------
async function postToNewRelic(events) {
  const res = await fetch(NR_EVENTS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Insert-Key': config.nrInsertKey,
    },
    body: JSON.stringify(events),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`NR API responded ${res.status}: ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Flush a snapshot of events to New Relic (up to 2 attempts)
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
// Drain the buffer atomically so in-flight events aren't double-sent
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
  reconnectPeriod: 5000,
  connectTimeout: 15000,
  keepalive: 60,
});

client.on('connect', () => {
  log('info', 'connected to MQTT broker', { url: config.mqttBrokerUrl });

  for (const topic of config.mqttTopics) {
    client.subscribe(topic, { qos: 0 }, (err) => {
      if (err) {
        log('error', 'failed to subscribe', { topic, error: err.message });
      } else {
        log('info', 'subscribed', { topic });
      }
    });
  }
});

client.on('reconnect', () => log('warn', 'reconnecting to MQTT broker'));
client.on('offline',   () => log('warn', 'MQTT client offline'));
client.on('error',     (err) => log('error', 'MQTT client error', { error: err.message }));

client.on('message', (topic, payload) => {
  counters.messagesReceived += 1;
  const receivedAt = Date.now();

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

  if (!raw.eventType) {
    counters.droppedNoEventType += 1;
    log('warn', 'message dropped: missing eventType', { topic });
    return;
  }

  // Infer timestamp from receive time if the payload omits it
  const event = raw.timestamp !== undefined ? raw : { ...raw, timestamp: receivedAt };

  eventBuffer.push(event);
  counters.eventsBuffered += 1;

  log('debug', 'event buffered', {
    topic,
    eventType: event.eventType,
    bufferSize: eventBuffer.length,
  });

  if (eventBuffer.length >= config.batchSize) {
    log('info', 'batch size limit reached, flushing', { batchSize: config.batchSize });
    drainBuffer().catch((err) => log('error', 'unexpected drain error', { error: err.message }));
  }
});

// ---------------------------------------------------------------------------
// Periodic flush
// ---------------------------------------------------------------------------
const flushTimer = setInterval(() => {
  drainBuffer().catch((err) => log('error', 'unexpected periodic drain error', { error: err.message }));
}, config.batchIntervalMs);
flushTimer.unref();

// ---------------------------------------------------------------------------
// Periodic stats log (every 60s)
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

  client.end(false, {}, async () => {
    try {
      await drainBuffer();
    } catch (err) {
      log('error', 'error flushing on shutdown', { error: err.message });
    }
    log('info', 'shutdown complete', { ...counters });
    process.exit(0);
  });

  setTimeout(() => {
    log('warn', 'forced exit after shutdown timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

log('info', 'nr-mqtt-relay starting', {
  mqttBrokerUrl: config.mqttBrokerUrl,
  mqttUsername: config.mqttUsername,
  mqttTopics: config.mqttTopics,
  nrAccountId: config.nrAccountId,
  batchSize: config.batchSize,
  batchIntervalMs: config.batchIntervalMs,
  logLevel: config.logLevel,
});
