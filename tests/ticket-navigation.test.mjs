import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');

test('工单 Shadow DOM 挂载到可移除子容器，切换其他后台页面不会被旧页面覆盖', () => {
  assert.match(source, /class="ticket-page-host"/);
  assert.match(source, /mountTicketPage\(host,/);
  assert.doesNotMatch(source, /mountTicketPage\(page,/);
  assert.match(source, /page\.applyTicketNotificationSnapshot=snapshot=>host\.applyTicketNotificationSnapshot/);
});
