import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractCustomerContacts, customerInfoReminder } from '../server/customer-info.mjs';
import { TencentDataStore, extractCustomerContacts as serverContacts, customerInfoReminder as serverReminder } from '../server/tencent-data-core.mjs';

const address = '1 Main St, Austin, TX 78701';
const email = 'ada@example.com';
const phone = '+1 5551234567';
const complete = `Ada\n${address}\n${email}\n${phone}`;

test('customer text still extracts the same emails and phones', () => {
  const intl = extractCustomerContacts('Alice ALICE@example.com +1 (626) 342-7272');
  assert.deepEqual(intl.emails, ['alice@example.com']);
  assert.ok(intl.phones.includes('16263427272'));
  assert.ok(intl.phones.includes('6263427272'));
  const china = extractCustomerContacts('13800138000');
  assert.ok(china.phones.includes('13800138000'));
  assert.ok(china.phones.includes('3800138000'));
  const prefixed = extractCustomerContacts('008613800138000');
  assert.ok(prefixed.phones.includes('8613800138000'));
  assert.ok(prefixed.phones.includes('13800138000'));
  assert.equal(extractCustomerContacts('no contact').emails.length, 0);
  assert.equal(extractCustomerContacts('no contact').phones.length, 0);
});

test('an order needs an address, an email, and a phone', () => {
  assert.equal(customerInfoReminder(complete), '');
  assert.equal(customerInfoReminder(`1 Main St, Austin ada@example.com ${phone}`), '');
  assert.equal(customerInfoReminder('Ada\n1 Main St, Austin, TX 78701\nada@example.com\n0016263427272'), '');
  assert.equal(customerInfoReminder('北京市朝阳区建国路1号\nzhang@example.com\n13800138000'), '');
  assert.equal(customerInfoReminder('9052A Main St, Austin TX 78701\nada@example.com\n+15551234567'), '');
  assert.equal(customerInfoReminder(`Ada\n${email}\n${phone}`), '客户信息还缺少：地址');
  assert.equal(customerInfoReminder(`Ada\n${address}\n${phone}`), '客户信息还缺少：邮箱');
  assert.equal(customerInfoReminder(`Ada\n${address}\n${email}`), '客户信息还缺少：电话');
  assert.equal(customerInfoReminder('   '), '客户信息还缺少：地址、邮箱、电话');
  for (const sample of [complete, `Ada\n${email}\n${phone}`, `Ada\n${address}\n${phone}`, '   ', '13800138000', 'Alice +1 (626) 342-7272']) {
    assert.equal(serverReminder(sample), customerInfoReminder(sample));
    assert.deepEqual(serverContacts(sample), extractCustomerContacts(sample));
  }
});

test('create and place reject incomplete customer details, and import still keeps them', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cargo-customer-'));
  const store = new TencentDataStore(join(dir, 'db.sqlite'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const business = store.upsertAccount({ email: 'demi@inflatable-zone.com', role: 'business' });
  const follower = store.upsertAccount({ email: 'follow@example.com', role: 'follower' });
  const imported = store.importShopifyOrder({
    id: 'gid://shopify/Order/incomplete', order_no: '#9100', product_name: 'Arch', quantity: 1,
    image_urls: ['https://cdn.shopify.com/a.jpg'], customer_info: 'Ada'
  });
  assert.equal(imported.customer_info, 'Ada');
  assert.equal(imported.current_step, 'sales_supplement');
  const place = extra => store.shopifyHandoff(business.id, {
    action: 'place', id: imported.id, order_no: '#9100', product_name: 'Arch', quantity: 1,
    business_name: 'Demi', shipping_mode: 'domestic_sea', blower: '包风机', abnormal_note: '备注', ...extra
  });
  assert.throws(() => place({ customer_info: `Ada\n${email}\n${phone}` }), error => error.status === 400 && error.message === '客户信息还缺少：地址');
  assert.throws(() => place({ customer_info: `Ada\n${address}\n${phone}` }), error => error.status === 400 && error.message === '客户信息还缺少：邮箱');
  assert.throws(() => place({ customer_info: `Ada\n${address}\n${email}` }), error => error.status === 400 && error.message === '客户信息还缺少：电话');
  assert.throws(() => place({ customer_info: '   ' }), error => error.status === 400 && /请补齐/.test(error.message));
  assert.equal(store.all('orders').find(row => row.id === imported.id).current_step, 'sales_supplement');
  place({ customer_info: complete });
  assert.equal(store.all('orders').find(row => row.id === imported.id).current_step, 'follower_create');
  assert.throws(() => store.shopifyHandoff(follower.id, {
    action: 'create', id: imported.id, order_no: '#9100', product_name: 'Arch', size: '3m', quantity: 1,
    customer_info: `Ada\n${address}\n${phone}`, business_name: 'Demi', destination_country: '美国',
    inventory_mode: 'production', needs_rendering: false, current_step: 'production'
  }), error => error.status === 400 && error.message === '客户信息还缺少：邮箱');
  const url = new URL('http://local/rest/v1/orders');
  assert.throws(() => store.mutate('orders', 'POST', url, {
    order_no: 'MANUAL-ADDR', product_name: 'Manual', quantity: 1, business_name: 'Demi', current_step: 'production',
    customer_info: `Ada\n${email}\n${phone}`
  }, follower.id), error => error.status === 400 && error.message === '客户信息还缺少：地址');
  const [created] = store.mutate('orders', 'POST', url, {
    order_no: 'MANUAL-OK', order_date: '2026-11-22', product_name: 'Manual', quantity: 1, business_name: 'Demi',
    current_step: 'production', customer_info: complete
  }, follower.id);
  assert.equal(created.customer_info, complete);
  const [edited] = store.mutate('orders', 'PATCH', new URL('http://local/rest/v1/orders?id=eq.' + created.id), { customer_info: 'Ada' }, follower.id);
  assert.equal(edited.customer_info, 'Ada');
});
