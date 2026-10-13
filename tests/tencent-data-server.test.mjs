import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TencentDataStore } from '../server/tencent-data-core.mjs';

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const { port } = socket.address();
      socket.close(error => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw Error(`data server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw Error('data server did not become healthy');
}

test('错误密码只返回 400，不会导致本地数据服务退出', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cargo-pulse-server-'));
  const port = await freePort();
  const store = new TencentDataStore(join(dataDir, 'test.sqlite'));
  store.put('app_settings', { key: 'business_invite', value: 'business-test-invite' });
  store.upsertAccount({ email: '505863160@qq.com', password: 'supervisor-password', role: 'follower' });
  const impersonationTarget = store.upsertAccount({ email: 'target@example.com', password: 'target-password', role: 'business' });
  store.put('orders', { id: 'tracking-order', order_no: 'TRACK-1', customer_info: 'Customer customer@example.com', current_step: 'ocean_transit' });
  store.put('order_events', { id: 'tracking-event', order_id: 'tracking-order', step_key: 'ocean_transit', note: 'tracking:SHIP123' });
  store.db.close();
  const child = spawn(process.execPath, [resolve('server/tencent-data-server.mjs')], {
    env: {
      ...process.env,
      PORT: String(port),
      CARGO_PULSE_DATA_DIR: dataDir,
      CARGO_PULSE_DB: join(dataDir, 'test.sqlite'),
      CARGO_PULSE_ORDER_UPLOADS: join(dataDir, 'uploads'),
      LEGACY_SUPABASE_URL: '',
      LEGACY_SUPABASE_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseUrl, child);
    const tracking = await fetch(`${baseUrl}/rest/v1/rpc/lookup_customer_tracking`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p_email: 'CUSTOMER@example.com' })
    });
    assert.equal(tracking.status, 200);
    const trackingResult = await tracking.json();
    assert.equal(trackingResult.found, true);
    assert.equal(trackingResult.order.order_no, 'TRACK-1');
    assert.equal(trackingResult.events[0].tracking_no, 'SHIP123');
    assert.deepEqual(trackingResult.shipments, []);
    const openSignup = await fetch(`${baseUrl}/auth/v1/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'supervisor@example.com', password: 'correct-password' })
    });
    assert.equal(openSignup.status, 403);
    assert.deepEqual(await openSignup.json(), { message: '注册链接无效，请联系主管获取最新邀请链接' });

    const signup = await fetch(`${baseUrl}/auth/v1/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'supervisor@example.com', password: 'correct-password', data: { registration_role: 'business', registration_invite: 'business-test-invite' } })
    });
    assert.equal(signup.status, 200);
    const signupSession = await signup.json();
    const authenticatedHeaders = { Authorization: `Bearer ${signupSession.access_token}` };
    const visibleProfiles = await fetch(`${baseUrl}/rest/v1/profiles?select=*`, { headers: authenticatedHeaders });
    assert.deepEqual((await visibleProfiles.json()).map(row => row.email), ['supervisor@example.com']);
    const hiddenInvites = await fetch(`${baseUrl}/rest/v1/app_settings?key=in.(business_invite,follower_invite)&select=*`, { headers: authenticatedHeaders });
    assert.deepEqual(await hiddenInvites.json(), []);
    const deniedImpersonation = await fetch(`${baseUrl}/rest/v1/rpc/impersonate_user`, {
      method: 'POST', headers: { ...authenticatedHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ target_user_id: impersonationTarget.id })
    });
    assert.equal(deniedImpersonation.status, 403);

    const supervisorLogin = await fetch(`${baseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: '505863160@qq.com', password: 'supervisor-password' })
    });
    const supervisorSession = await supervisorLogin.json();
    const impersonation = await fetch(`${baseUrl}/rest/v1/rpc/impersonate_user`, {
      method: 'POST', headers: { Authorization: `Bearer ${supervisorSession.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ target_user_id: impersonationTarget.id })
    });
    assert.equal(impersonation.status, 200);
    const impersonatedSession = await impersonation.json();
    assert.equal(impersonatedSession.user.email, 'target@example.com');
    assert.equal(impersonatedSession.impersonated_by.email, '505863160@qq.com');

    const rejected = await fetch(`${baseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'supervisor@example.com', password: 'wrong-password' })
    });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { message: '邮箱或密码错误' });

    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).web_push, true);
    assert.equal(child.exitCode, null);

    const pushHealth = await fetch(`${baseUrl}/rest/v1/rpc/push_health`, { method: 'POST', body: '{}' });
    assert.equal(pushHealth.status, 200);
    assert.deepEqual(await pushHealth.json(), { ok: true, web_push: true });

    const accepted = await fetch(`${baseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'supervisor@example.com', password: 'correct-password' })
    });
    assert.equal(accepted.status, 200);
    assert.ok((await accepted.json()).access_token);
  } finally {
    child.kill();
    await new Promise(resolveExit => child.once('exit', resolveExit));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
