import { join } from 'node:path';
let TencentDataStore, TicketService, WebPushService;
try {
  ({ TencentDataStore } = await import('../server/tencent-data-core.mjs'));
  ({ TicketService } = await import('../server/ticket-service.mjs'));
  ({ WebPushService } = await import('../server/web-push.mjs'));
} catch {
  ({ TencentDataStore } = await import('./tencent-data-core.mjs'));
  ({ TicketService } = await import('./ticket-service.mjs'));
  try { ({ WebPushService } = await import('./web-push.mjs')); }
  catch { ({ WebPushService } = await import('file:///var/www/cargo-pulse/runtime/web-push.mjs')); }
}

const dataDir = process.env.CARGO_PULSE_DATA_DIR || '/var/lib/cargo-pulse/data';
const database = process.env.CARGO_PULSE_DB || join(dataDir, 'cargo-pulse.sqlite');
const store = new TencentDataStore(database);
try {
  const tickets = new TicketService(store);
  const push = new WebPushService(store);
  tickets.setNotificationHandler(notification => push.queueTicketNotification(notification, tickets));
  const result = tickets.runReminders();
  await push.flush();
  console.log(`Ticket reminders complete: ${result.created} notification(s) created.`);
} finally {
  store.db.close();
}
