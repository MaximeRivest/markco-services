import { EventEmitter } from 'node:events';

const bus = new EventEmitter();

/** Ring buffer of the last 100 events for debugging. */
const recentEvents = [];
const MAX_RECENT = 100;

/** Registered webhook URLs. */
const webhooks = new Set();

function pushEvent(event) {
  recentEvents.push(event);
  if (recentEvents.length > MAX_RECENT) recentEvents.shift();
  bus.emit(event.type, event);
  bus.emit('*', event);
  notifyWebhooks(event);
}

async function notifyWebhooks(event) {
  for (const url of webhooks) {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Webhook delivery is best-effort; don't crash the monitor.
    }
  }
}

function registerWebhook(url) {
  webhooks.add(url);
}

function unregisterWebhook(url) {
  webhooks.delete(url);
}

function getRecentEvents() {
  return recentEvents.slice();
}

function getWebhooks() {
  return [...webhooks];
}

export { bus, pushEvent, registerWebhook, unregisterWebhook, getRecentEvents, getWebhooks };
