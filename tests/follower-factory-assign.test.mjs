import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { TencentDataStore } from '../server/tencent-data-core.mjs';

const CUSTOMER = 'Ada\n1 Main St, Austin, TX 78701\nada@example.com\n+1 5551234567';
const BLOCKED = '请先选择并保存工厂，再创建订单。';
const app = readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cargo-factory-gate-'));
  const store = new TencentDataStore(join(dir, 'db.sqlite'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const business = store.upsertAccount({ email: 'demi@inflatable-zone.com', role: 'business' });
  const follower = store.upsertAccount({ email: 'follow@example.com', role: 'follower' });
  const supervisor = store.upsertAccount({ email: '505863160@qq.com', role: 'business' });
  store.put('partners', { id: 'factory-a', kind: 'factory', name: 'Factory A', active: true });
  store.put('partners', { id: 'factory-b', kind: 'factory', name: 'Factory B', active: false });
  store.put('partners', { id: 'forwarder-a', kind: 'forwarder', name: 'Forwarder A', active: true });
  const order = store.put('orders', {
    id: 'wait-1', order_no: '#9053', current_step: 'follower_create', product_name: 'Arch', quantity: 2,
    customer_info: CUSTOMER, business_name: 'Demi', business_id: business.id
  });
  return { store, business, follower, supervisor, order };
}

function createPayload(extra = {}) {
  return {
    action: 'create', id: 'wait-1', order_no: '#9053', product_name: 'Arch', size: '3 x 2 m', quantity: 2,
    customer_info: CUSTOMER, business_name: 'Demi', destination_country: '美国', inventory_mode: 'production',
    needs_rendering: false, shipping_mode: 'domestic_express', current_step: 'production', ...extra
  };
}

test('a merchandiser cannot create 待跟单创建订单 until a merchandiser or supervisor saves a catalog factory', t => {
  const { store, follower, supervisor, business } = fixture(t);
  assert.equal(supervisor.role, 'follower');
  assert.throws(
    () => store.shopifyHandoff(follower.id, createPayload({ factory_name: 'Factory A', factory_names: ['Factory A'] })),
    error => error.status === 400 && error.message === BLOCKED
  );
  assert.equal(store.all('orders').find(row => row.id === 'wait-1').current_step, 'follower_create');
  assert.equal(store.all('orders').find(row => row.id === 'wait-1').factory_name, undefined);
  assert.throws(
    () => store.shopifyHandoff(business.id, { action: 'assign_factory', id: 'wait-1', factory_name: 'Factory A' }),
    error => error.status === 403
  );
  assert.throws(
    () => store.mutate('orders', 'PATCH', new URL('http://local/rest/v1/orders?id=eq.wait-1'), { factory_name: 'Factory A' }, follower.id),
    error => error.status === 403
  );
  assert.throws(
    () => store.shopifyHandoff(supervisor.id, { action: 'assign_factory', id: 'wait-1', factory_name: 'Factory B' }),
    error => error.status === 400 && error.message === '请选择已有工厂'
  );
  assert.throws(
    () => store.shopifyHandoff(supervisor.id, { action: 'assign_factory', id: 'wait-1', factory_name: 'Forwarder A' }),
    error => error.status === 400 && error.message === '请选择已有工厂'
  );
  assert.throws(
    () => store.shopifyHandoff(supervisor.id, { action: 'assign_factory', id: 'wait-1', factory_name: '   ' }),
    error => error.status === 400 && error.message === '请选择工厂'
  );
  store.put('orders', { ...store.all('orders').find(row => row.id === 'wait-1'), factory_name: '   ' });
  assert.throws(
    () => store.shopifyHandoff(follower.id, createPayload()),
    error => error.status === 400 && error.message === BLOCKED
  );

  const saved = store.shopifyHandoff(follower.id, { action: 'assign_factory', id: 'wait-1', factory_name: ' Factory A ' });
  assert.equal(saved.factory_name, 'Factory A');
  assert.equal(saved.current_step, 'follower_create');
  const waiting = store.all('orders').find(row => row.id === 'wait-1');
  assert.equal(waiting.factory_name, 'Factory A');
  assert.equal(waiting.current_step, 'follower_create');
  assert.equal(waiting.order_no, '#9053');
  assert.throws(
    () => store.shopifyHandoff(follower.id, createPayload({ factory_name: 'Factory B' })),
    error => error.status === 400 && error.message === '工厂已保存，请通过更换工厂修改'
  );
  assert.equal(store.all('orders').find(row => row.id === 'wait-1').current_step, 'follower_create');
  assert.equal(store.all('orders').find(row => row.id === 'wait-1').factory_name, 'Factory A');

  const replaced = store.shopifyHandoff(supervisor.id, { action: 'assign_factory', id: 'wait-1', factory_name: 'Factory A' });
  assert.equal(replaced.factory_name, 'Factory A');
  const created = store.shopifyHandoff(follower.id, createPayload({ factory_names: ['Factory A', 'Extra Shop'] }));
  assert.equal(created.current_step, 'production');
  const order = store.all('orders').find(row => row.id === 'wait-1');
  assert.equal(order.factory_name, 'Factory A');
  assert.deepEqual(store.all('order_factories').filter(row => row.order_id === order.id).map(row => row.factory_name), ['Factory A', 'Extra Shop']);
  assert.throws(
    () => store.shopifyHandoff(supervisor.id, { action: 'assign_factory', id: 'wait-1', factory_name: 'Factory A' }),
    error => error.status === 409
  );
});

function line(name) {
  const found = app.split('\n').find(item => item.startsWith('function ' + name + '('));
  assert.ok(found, name);
  return found;
}

test('a supervisor opens the full order and saves a catalog factory at the bottom', () => {
  const catalog = app.slice(app.indexOf('function followerFactoryChoices'), app.indexOf('function openShopifyPlace'));
  const gate = app.slice(app.indexOf('function openFollowerCreate'), app.indexOf('const factoryExportSelection'));
  const create = app.slice(app.indexOf('function openShopifyCreate'), app.indexOf('function detailHtml'));
  assert.match(catalog, /partners\.filter\(p=>p\.kind==='factory'&&p\.active!==false\)/);
  assert.match(catalog, /'库存','海外仓'/);
  assert.match(catalog, /id="followerFactoryForm"/);
  assert.match(catalog, /<h3>选择工厂<\/h3>/);
  assert.match(catalog, /select name="factory_name"/);
  assert.match(catalog, /保存工厂/);
  assert.match(catalog, /action:'assign_factory',id:o\.id,factory_name/);
  assert.match(catalog, /还没有可选工厂/);
  assert.match(gate, /if\(isSupervisor\(\)\)return false/);
  assert.equal(gate.includes('openFollowerFactoryAssign'), true);
  assert.match(gate, /openFollowerFactoryAssign\(o,detailDialog,true\)/);
  assert.match(gate, /followerFactorySaved\(o\)\)\{openShopifyCreate\(o,detailDialog\);return true\}/);
  assert.match(app, /d\.innerHTML=detailHtml\(o\);d\.showModal\(\);bindFollowerFactoryAssign\(d\.querySelector\('#followerFactoryForm'\),o,d\);mountSupervisorSalesImages\(d,o\);void mountIssueOrder\(o,d\);keepSupervisorFactoryAtBottom\(d\)/);
  assert.match(app, /if\(supervisorAwaitingFactoryDetail\(o\)\)return supervisorSalesReviewHtml\(o\)/);
  assert.match(app, /function supervisorSalesReviewHtml\(o\)\{const note=o\.abnormal_note\|\|o\.requirements\|\|'';return `<div class="detail supervisor-sales-review">/);
  assert.equal(app.includes('supervisor&&!followerFactorySaved(o)?followerFactoryAssignHtml(o)'), false);
  assert.equal(create.includes('openFollowerFactoryAssign(o,detailDialog);return'), false);
  assert.match(create, /input\.readOnly=true/);
  assert.match(create, /通过更换工厂保存后生效/);
  assert.match(create, /id='changeFollowerFactory'/);
  assert.match(create, /payload\.factory_name=String\(o\.factory_name\|\|''\)\.trim\(\)/);
  assert.match(create, /action:'create'/);
  assert.equal(create.includes('openShopifyPlace'), false);
  assert.equal(create.includes('bindProductNameRule'), false);

  const partners = [
    { kind: 'factory', name: 'Factory A', active: true },
    { kind: 'factory', name: 'Factory B', active: false },
    { kind: 'forwarder', name: 'Forwarder A', active: true }
  ];
  const order = {
    id: 'wait-1', order_no: '#9053', product_name: 'Arch', quantity: 2, size: '3 x 2 m',
    customer_info: CUSTOMER, abnormal_note: '请加急，备注要完整显示，不要截断', requirements: '备用要求',
    business_name: 'Demi', shipping_mode: 'domestic_sea', blower: '风机',
    current_step: 'follower_create', factory_name: '', forwarder_name: '',
    shopify_image_urls: ['https://cdn.example/arch.jpg']
  };
  const sandbox = {
    partners,
    profile: { role: 'business', email: '505863160@qq.com' },
    STEP_LABELS: { follower_create: '待跟单创建订单' },
    flowFor: () => ['production', 'completed'],
    stableStepKey: step => step,
    esc: value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])),
    orderQuantityLabel: row => row.quantity ?? '',
    returningCustomerHtml: () => '',
    badge: () => '<span class="alert normal">正常</span>',
    factoryProductionHtml: () => '',
    batchShippingHtml: () => '',
    overallDeadline: () => null,
    factoryDisplay: () => '-',
    trackingEntries: () => [],
    proofApplies: () => false,
    needsDeliveryProof: () => false,
    proofRecord: () => null,
    isOrderSalesperson: () => false,
    allFactoriesCompleted: () => true,
    trackingForStep: () => ''
  };
  const source = [
    line('followerFactorySaved'),
    line('followerFactoryChoices'),
    line('followerFactoryFields'),
    line('followerFactoryAssignHtml'),
    line('orderAwaitingFactory'),
    line('supervisorAwaitingFactoryDetail'),
    line('salespersonOrderNoLabel'),
    line('salespersonShippingLabel'),
    line('salespersonBlowerLabel'),
    line('salespersonSubmittedValue'),
    line('supervisorSalesReviewHtml'),
    line('detailHtml'),
    line('bindFollowerFactoryAssign'),
    line('orderMatchesStatusTab'),
    line('displayStepLabel')
  ].join('\n');
  const view = runInNewContext(source + '\n({html:detailHtml(order),label:displayStepLabel(order),tab:orderMatchesStatusTab(order,"follower_create"),active:orderMatchesStatusTab(order,"active")})', { ...sandbox, order, displayStepKey: row => row.current_step });
  const fields = ['后台订单号', '#9053', '产品名称', 'Arch', '数量', '2', '尺寸', '3 x 2 m', '负责业务员', 'Demi', '运输方式', '海运', '风机 / 气泵', '包风机', '客户地址和联系信息', CUSTOMER, '订单备注', '请加急，备注要完整显示，不要截断', '产品图片'];
  let cursor = -1;
  for (const field of fields) {
    const at = view.html.indexOf(field, cursor + 1);
    assert.ok(at > cursor, field);
    cursor = at;
  }
  const imagesAt = view.html.indexOf('supervisor-sales-images');
  const formAt = view.html.indexOf('id="followerFactoryForm"');
  const saveAt = view.html.indexOf('保存工厂');
  assert.ok(imagesAt > cursor && formAt > imagesAt && saveAt > formAt);
  assert.match(view.html, /<h2>待选择工厂<\/h2>/);
  assert.match(view.html, /<h3>选择工厂<\/h3>/);
  assert.match(view.html, /class="detail supervisor-sales-review"/);
  assert.equal(view.html.includes('<h2>选择工厂</h2>'), false);
  assert.equal(view.html.includes('<h2>Arch'), false);
  assert.equal(view.html.includes('步骤时间线'), false);
  assert.equal(view.html.includes('签收证明'), false);
  assert.equal(view.html.includes('id="shopifyCreate"'), false);
  assert.equal(view.html.includes('<textarea'), false);
  assert.equal(view.html.includes('<input'), false);
  assert.equal(view.html.includes('type="file"'), false);
  assert.equal(view.html.includes('product-image-delete'), false);
  assert.equal(view.html.includes('添加图片'), false);
  assert.equal(view.html.includes('name="order_no"'), false);
  assert.equal(view.html.includes('name="customer_info"'), false);
  assert.equal(view.html.includes('name="abnormal_note"'), false);
  assert.equal((view.html.match(/<select /g) || []).length, 1);
  assert.match(view.html, /select name="factory_name" required/);
  assert.match(view.html, /<option value="Factory A"/);
  assert.match(view.html, /<option value="库存"/);
  assert.match(view.html, /<option value="海外仓"/);
  const factoryA = view.html.indexOf('<option value="Factory A"');
  const stock = view.html.indexOf('<option value="库存"');
  const overseas = view.html.indexOf('<option value="海外仓"');
  assert.ok(factoryA > 0 && factoryA < stock && stock < overseas);
  assert.equal((view.html.match(/<option value="库存"/g) || []).length, 1);
  assert.equal((view.html.match(/<option value="海外仓"/g) || []).length, 1);
  assert.equal(view.html.includes('Factory B'), false);
  assert.equal(view.html.includes('Forwarder A'), false);
  assert.equal(view.html.includes('备用要求'), false);
  assert.equal(view.label, '待选择工厂');
  assert.equal(view.tab, false);
  assert.equal(view.active, true);
  assert.match(app, /label=esc\(displayStepLabel\(o\)\)/);
  const css = readFileSync(new URL('../style-v2.css', import.meta.url), 'utf8');
  assert.match(css, /\.supervisor-sales-review \.supervisor-sales-fields dd\{white-space:pre-wrap;overflow-wrap:anywhere\}/);

  const custom = runInNewContext(source + '\ndetailHtml(order)', { ...sandbox, order: { ...order, salesperson_shared: true, order_no: 'IZ-200', shipping_mode: 'air_freight', blower: '不包气泵', abnormal_note: '', requirements: '只写在要求里' } });
  assert.match(custom, /<dt>自定义订单号<\/dt><dd>IZ-200<\/dd>/);
  assert.match(custom, /<dt>运输方式<\/dt><dd>国内空运<\/dd>/);
  assert.match(custom, /<dt>风机 \/ 气泵<\/dt><dd>不包气泵<\/dd>/);
  assert.match(custom, /<dt>订单备注<\/dt><dd>只写在要求里<\/dd>/);
  assert.equal(custom.includes('后台订单号'), false);

  sandbox.profile = { role: 'follower', email: 'follow@example.com' };
  const merchandiser = runInNewContext(source + '\ndetailHtml(order)', { ...sandbox, order });
  assert.equal(merchandiser.includes('followerFactoryForm'), false);
  assert.equal(merchandiser.includes('supervisor-sales-fields'), false);
  assert.match(merchandiser, /步骤时间线/);
  assert.match(merchandiser, /id="shopifyCreate">创建订单/);

  sandbox.profile = { role: 'business', email: '505863160@qq.com' };
  const deleted = runInNewContext(source + '\ndetailHtml(order)', { ...sandbox, order: { ...order, deleted_at: '2026-11-01' } });
  assert.equal(deleted.includes('supervisor-sales-fields'), false);
  assert.equal(deleted.includes('followerFactoryForm'), false);

  const savedOrder = { ...order, factory_name: 'Factory A' };
  sandbox.profile = { role: 'follower', email: '505863160@qq.com' };
  const ready = runInNewContext(source + '\n({html:detailHtml(order),tab:orderMatchesStatusTab(order,"follower_create"),label:displayStepLabel(order)})', { ...sandbox, order: savedOrder, displayStepKey: row => row.current_step });
  assert.equal(ready.html.includes('followerFactoryForm'), false);
  assert.match(ready.html, /id="shopifyCreate">创建订单/);
  assert.equal(ready.tab, true);
  assert.equal(ready.label, '待跟单创建订单');

  const calls = [];
  const button = { disabled: false };
  const error = { textContent: '' };
  const dialog = { open: true, close() { this.open = false; } };
  const form = {
    onsubmit: null,
    closest() { return dialog; },
    querySelector(selector) {
      if (selector === 'button.primary') return button;
      if (selector === '.error') return error;
      return null;
    }
  };
  const orders = [order];
  runInNewContext(line('bindFollowerFactoryAssign') + '\nbindFollowerFactoryAssign(form, order, dialog, true);', {
    form,
    order,
    dialog,
    orders,
    api: async (path, options) => {
      calls.push({ path, body: JSON.parse(options.body) });
      return { factory_name: 'Factory A', current_step: 'follower_create' };
    },
    refresh: async () => { calls.push({ path: 'refresh' }); },
    openShopifyCreate(row) { calls.push({ path: 'create', factory: row.factory_name }); },
    FormData: class {
      get(name) { return name === 'factory_name' ? 'Factory A' : ''; }
    }
  });
  return form.onsubmit({ preventDefault() {} }).then(() => {
    assert.deepEqual(calls[0], {
      path: '/rest/v1/rpc/shopify_order_handoff',
      body: { action: 'assign_factory', id: 'wait-1', factory_name: 'Factory A' }
    });
    assert.equal(calls[1].path, 'refresh');
    assert.deepEqual(calls[2],{path:'create',factory:'Factory A'});
    assert.equal(dialog.open, false);
    assert.equal(order.factory_name, 'Factory A');
    assert.equal(order.current_step, 'follower_create');
    const after = runInNewContext(line('followerFactorySaved') + '\n' + line('orderMatchesStatusTab') + '\n' + line('displayStepLabel') + '\n({tab:orderMatchesStatusTab(order,"follower_create"),label:displayStepLabel(order)})', {
      order,
      STEP_LABELS: { follower_create: '待跟单创建订单' },
      displayStepKey: row => row.current_step
    });
    assert.equal(after.tab, true);
    assert.equal(after.label, '待跟单创建订单');
  });
});

test('the supervisor review shows every salesperson product image and keeps 保存工厂 last', () => {
  const mount = app.slice(app.indexOf('function mountSupervisorSalesImages'), app.indexOf('function keepSupervisorFactoryAtBottom'));
  const pin = app.slice(app.indexOf('function keepSupervisorFactoryAtBottom'), app.indexOf('function bind()'));
  assert.match(mount, /appendShopifyImages\(gallery,order\.shopify_image_urls\)/);
  assert.match(mount, /showUploadedProductImages\(gallery,order\.id\)/);
  assert.equal(mount.includes('product-image-delete'), false);
  assert.equal(mount.includes('type="file"'), false);
  assert.equal(mount.includes('salesperson_supplement'), false);
  const gallery = { images: [] };
  const root = { querySelector(selector) { return selector === '.supervisor-sales-images' ? gallery : null; } };
  const order = { id: 'wait-1', shopify_image_urls: ['https://cdn.example/arch.jpg', 'http://insecure.example/skip.jpg'] };
  runInNewContext(mount + '\nmountSupervisorSalesImages(root, order);', {
    root,
    order,
    appendShopifyImages(node, urls) { node.images.push(...urls); },
    showUploadedProductImages(node, id) { node.images.push('upload:' + id); return Promise.resolve(); }
  });
  assert.deepEqual(gallery.images, ['https://cdn.example/arch.jpg', 'http://insecure.example/skip.jpg', 'upload:wait-1']);

  const form = { id: 'followerFactoryForm' };
  const panel = { id: 'issues' };
  const detail = {
    className: 'detail supervisor-sales-review',
    children: [form],
    querySelector(selector) { return selector === '#followerFactoryForm' ? form : null; },
    append(node) { this.children = this.children.filter(child => child !== node).concat(node); }
  };
  form.closest = selector => selector === '.detail' ? detail : null;
  detail.children.push(panel);
  runInNewContext(pin + '\nkeepSupervisorFactoryAtBottom(detail);', { detail });
  assert.equal(detail.children.at(-1), form);
  assert.equal(detail.children[0], panel);
});

test('库存 and 海外仓 stay with the catalog list, including 更换工厂, without dropping existing factories', () => {
  const choices = partners => [...runInNewContext(line('followerFactoryChoices') + '\nfollowerFactoryChoices()', { partners })];
  assert.deepEqual(choices([
    { kind: 'factory', name: ' Factory A ', active: true },
    { kind: 'factory', name: 'Factory B', active: false },
    { kind: 'factory', name: '库存', active: true },
    { kind: 'factory', name: '   ', active: true },
    { kind: 'forwarder', name: 'Forwarder A', active: true }
  ]), ['Factory A', '库存', '海外仓']);
  assert.deepEqual(choices([]), ['库存', '海外仓']);

  const dialog = {
    innerHTML: '',
    open: false,
    showModal() { this.open = true; },
    close() { this.open = false; },
    querySelector() { return {}; }
  };
  runInNewContext(
    [line('followerFactoryChoices'), line('followerFactoryFields'), line('bindFollowerFactoryAssign'), line('openFollowerFactoryAssign')].join('\n') + '\nopenFollowerFactoryAssign(order);',
    {
      order: { id: 'wait-1', factory_name: '海外仓' },
      partners: [
        { kind: 'factory', name: 'Factory A', active: true },
        { kind: 'factory', name: 'Factory B', active: false },
        { kind: 'forwarder', name: '海外仓', active: true }
      ],
      esc: value => String(value ?? ''),
      $: () => dialog
    }
  );
  assert.equal(dialog.open, true);
  assert.match(dialog.innerHTML, /<h2>选择工厂<\/h2>/);
  assert.match(dialog.innerHTML, /<option value="Factory A"/);
  assert.match(dialog.innerHTML, /<option value="库存"/);
  assert.match(dialog.innerHTML, /<option value="海外仓" selected>/);
  assert.match(dialog.innerHTML, />保存工厂</);
  assert.equal(dialog.innerHTML.includes('Factory B'), false);
  assert.equal(dialog.innerHTML.includes('Forwarder A'), false);
  assert.equal((dialog.innerHTML.match(/<option value="海外仓"/g) || []).length, 1);
  const factoryA = dialog.innerHTML.indexOf('<option value="Factory A"');
  const stock = dialog.innerHTML.indexOf('<option value="库存"');
  const overseas = dialog.innerHTML.indexOf('<option value="海外仓"');
  assert.ok(factoryA > 0 && factoryA < stock && stock < overseas);
});

test('a supervisor can save 库存 or 海外仓, and a merchandiser can then create the order', t => {
  const { store, follower, supervisor, business } = fixture(t);
  store.put('partners', { id: 'stock-off', kind: 'factory', name: '库存', active: false });
  store.put('orders', {
    id: 'wait-2', order_no: '#9054', current_step: 'follower_create', product_name: 'Arch', quantity: 2,
    customer_info: CUSTOMER, business_name: 'Demi', business_id: business.id
  });
  assert.throws(
    () => store.shopifyHandoff(supervisor.id, { action: 'assign_factory', id: 'wait-1', factory_name: '库存仓' }),
    error => error.status === 400 && error.message === '请选择已有工厂'
  );
  for (const [id, name, orderNo] of [['wait-1', '库存', '#9053'], ['wait-2', '海外仓', '#9054']]) {
    const saved = store.shopifyHandoff(supervisor.id, { action: 'assign_factory', id, factory_name: ` ${name} ` });
    assert.equal(saved.factory_name, name);
    assert.equal(saved.current_step, 'follower_create');
    const waiting = store.all('orders').find(row => row.id === id);
    assert.equal(waiting.factory_name, name);
    assert.equal(waiting.current_step, 'follower_create');
    assert.equal(waiting.order_no, orderNo);
    const created = store.shopifyHandoff(follower.id, createPayload({ id, order_no: orderNo, factory_name: name }));
    assert.equal(created.current_step, 'production');
    const order = store.all('orders').find(row => row.id === id);
    assert.equal(order.factory_name, name);
    assert.equal(order.current_step, 'production');
    assert.deepEqual(store.all('order_factories').filter(row => row.order_id === id).map(row => row.factory_name), [name]);
  }
  assert.equal(store.all('partners').some(partner => partner.active !== false && (partner.name === '库存' || partner.name === '海外仓')), false);
  assert.equal(store.all('partners').some(partner => partner.kind === 'factory' && partner.name === 'Factory A' && partner.active !== false), true);
});
