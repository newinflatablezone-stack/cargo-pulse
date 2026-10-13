import { join } from 'node:path';
import { TencentDataStore } from './tencent-data-core.mjs';
import { TicketService } from './ticket-service.mjs';
import { WebPushService } from './web-push.mjs';

const dataDir = process.env.CARGO_PULSE_DATA_DIR || '/var/lib/cargo-pulse/data';
const database = process.env.CARGO_PULSE_DB || join(dataDir, 'cargo-pulse.sqlite');
const notificationId = String(process.env.CARGO_PULSE_PUSH_NOTIFICATION_ID || '');
const store = new TencentDataStore(database);

try {
  const tickets = new TicketService(store);
  const push = new WebPushService(store);
  if (notificationId) {
    const notification = store.all('ticket_notifications').find(row => row.id === notificationId);
    if (notification) await push.queueTicketNotification(notification, tickets);
    console.log(`Ticket push complete: ${notification ? notification.id : 'notification-not-found'}.`);
  } else {
    tickets.setNotificationHandler(notification => push.queueTicketNotification(notification, tickets));
    const reminders = tickets.runReminders();
    await push.flush();
    const retry = await push.retryPendingTicketNotifications(tickets);
    console.log(`Ticket push sweep complete: ${reminders.created} created, ${retry.attempted} retried, ${retry.sent} sent.`);
  }
} finally {
  store.db.close();
}
