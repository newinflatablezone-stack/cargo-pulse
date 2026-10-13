import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyDestination } from '../server/destination-risk.mjs';
import { TencentDataStore } from '../server/tencent-data-core.mjs';

test('美加墨澳英、西欧、日本、新加坡等主流目的地支持中英文别名', () => {
  for (const country of ['美国', 'U.S.A.', 'Canada', 'México', 'Australia', 'United Kingdom', 'France', 'Deutschland', '日本', 'Singapore', 'New Zealand', 'South Korea']) {
    assert.equal(classifyDestination(country).mainstream, true, country);
  }
  for (const country of ['Brazil', '沙特阿拉伯', 'Chile', 'South Africa']) {
    assert.equal(classifyDestination(country).risk, 'non_mainstream', country);
  }
});

test('非主流目的地必须确认并由服务端记录确认账号和时间', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cargo-pulse-destination-'));
  const store = new TencentDataStore(join(directory, 'test.sqlite'));
  try {
    const follower = store.upsertAccount({ email: 'follower@example.com', password: 'password', role: 'follower' });
    const url = new URL('http://local/rest/v1/orders');
    assert.throws(
      () => store.mutate('orders', 'POST', url, { order_no: 'RISK-1', destination_country: 'Brazil' }, follower.id),
      /非主流地址/
    );
    const [created] = store.mutate('orders', 'POST', url, {
      order_no: 'RISK-2', destination_country: 'Brazil', destination_risk_acknowledged: true
    }, follower.id);
    assert.equal(created.destination_risk, 'non_mainstream');
    assert.equal(created.destination_risk_acknowledged_by, 'follower@example.com');
    assert.ok(created.destination_risk_acknowledged_at);

    const [mainstream] = store.mutate('orders', 'POST', url, {
      order_no: 'MAIN-1', destination_country: 'USA', destination_risk_acknowledged: true
    }, follower.id);
    assert.equal(mainstream.destination_country, '美国');
    assert.equal(mainstream.destination_risk, 'mainstream');
    assert.equal(mainstream.destination_risk_acknowledged, false);
  } finally {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
