import { join } from 'node:path';
import { TencentDataStore } from '../server/tencent-data-core.mjs';
import { TicketService } from '../server/ticket-service.mjs';

const dataDir = process.env.CARGO_PULSE_DATA_DIR || '/var/lib/cargo-pulse/data';
const database = process.env.CARGO_PULSE_DB || join(dataDir, 'cargo-pulse.sqlite');
const store = new TencentDataStore(database);
try {
  const result = new TicketService(store).runReminders();
  console.log(`Ticket reminders complete: ${result.created} notification(s) created.`);
} finally {
  store.db.close();
}
