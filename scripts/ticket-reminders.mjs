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
  const notificationId = String(process.env.CARGO_PULSE_PUSH_NOTIFICATION_ID || '');
  if (notificationId) {
    const notification = store.all('ticket_notifications').find(row => row.id === notificationId);
    if (notification) await push.queueTicketNotification(notification, tickets);
    console.log(`Ticket push worker complete: ${notification ? notification.id : 'notification-not-found'}.`);
  } else {
    tickets.setNotificationHandler(notification => push.queueTicketNotification(notification, tickets));
    const result = tickets.runReminders();
    await push.flush();
    const retry = await push.retryPendingTicketNotifications(tickets);
    console.log(`Ticket reminders complete: ${result.created} created, ${retry.attempted} retried, ${retry.sent} sent.`);
  }
} finally {
  store.db.close();
}
