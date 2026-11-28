import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TencentDataStore, isPurelyNumericOrderNumber, CUSTOM_ORDER_NUMBER_RULE, beijingOrderDate } from '../server/tencent-data-core.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cargo-sales-order-'));
  const store = new TencentDataStore(join(dir, 'db.sqlite'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const business = store.upsertAccount({ email: 'demi@inflatable-zone.com', role: 'business' });
  const other = store.upsertAccount({ email: 'sherry@inflatable-zone.com', role: 'business' });
  const rayna = store.upsertAccount({ email: 'rayna@inflatable-zone.com', role: 'business' });
  const follower = store.upsertAccount({ email: 'follow@example.com', role: 'follower' });
  const supervisor = store.upsertAccount({ email: '505863160@qq.com', role: 'follower' });
  return { store, business, other, rayna, follower, supervisor };
}

function fields(extra = {}) {
  return {
    product_name: '城堡', quantity: 2, size: '3 x 2 m', business_name: 'Demi',
    shipping_mode: 'domestic_sea', blower: '包风机', customer_info: 'Ada\n1 Main St, Austin, TX 78701\nada@example.com\n+1 5551234567', abnormal_note: '请加急',
    ...extra
  };
}

function attachImage(store, id) {
  store.put('order_images', { order_id: id, object_path: `${id}/product-image-photo.jpg`, file_name: '产品图片' });
}

test('saved manual drafts keep incomplete lines and images private until formal placement', t => {
  const {store,business,other,follower}=fixture(t);
  const request=(action, data={})=>store.salespersonOrder(business.id,{action,...data});
  const {id}=request('draft');
  const path=`${id}/product-image-draft-${business.id}--sample.png`;
  store.put('order_images',{order_id:id,object_path:path});
  const partial={id,order_no:'DRAFT-1',business_name:'Demi',products:[
    {product_name:'Incomplete Title',quantity:'2',image_paths:[path]}, {size:'3 米'}
  ]};
  const first=request('save_draft',partial);
  assert.deepEqual(request('save_draft',partial),first);
  assert.equal(request('list_drafts')[0].id,id);
  assert.equal(request('get_draft',{id}).draft.products[1].size,'3 米');
  assert.deepEqual(request('get_draft',{id}).draft.products[0].image_paths,[path]);
  assert.equal(store.all('order_events').some(row=>row.order_id===id),false);
  assert.equal(store.canReadObject(business.id,path),true);
  assert.equal(store.canReadObject(other.id,path),false);
  assert.equal(store.canReadObject(follower.id,path),false);
  assert.deepEqual(store.salespersonOrder(other.id,{action:'list_drafts'}),[]);
  assert.throws(()=>store.salespersonOrder(other.id,{action:'get_draft',id}),{status:409});
  assert.throws(()=>request('place',{...partial,draft_updated_at:first.updated_at}),/产品名称须含中文/);
  assert.throws(()=>request('discard',{id}),{status:409});
  const revised=request('save_draft',{...partial,draft_updated_at:first.updated_at,shipping_mode:'domestic_sea'});
  assert.notEqual(revised.updated_at,first.updated_at);
  assert.throws(()=>request('save_draft',{...partial,draft_updated_at:first.updated_at,order_no:'STALE'}),{status:409});
  const ready={id,...fields({order_no:'DRAFT-1'}),products:[{...fields(),requirements:'加急',image_paths:[path]}]};
  assert.throws(()=>request('place',{...ready,draft_updated_at:first.updated_at}),{status:409});
  assert.equal(request('place',{...ready,draft_updated_at:revised.updated_at}).current_step,'follower_create');
  assert.equal(store.canReadObject(follower.id,path),true);
  assert.deepEqual(request('list_drafts'),[]);
});

test('Shopify drafts are per salesperson and do not claim or change the shared order', t => {
  const {store,business,other,follower}=fixture(t);
  const {id}=store.importShopifyOrder({id:'gid://shopify/Order/9000',order_no:'#9000',products:[{product_name:'Imported Title'}]});
  const path=`${id}/product-image-draft-${business.id}--sample.png`;
  const otherPhoto=`${id}/product-image-draft-${other.id}--second.png`;
  store.put('order_images',{order_id:id,object_path:path});
  store.put('order_images',{order_id:id,object_path:otherPhoto});
  const partial={id,action:'save_draft',order_no:'#9000',business_name:'Demi',products:[{product_name:'未完成',image_paths:[path]}]};
  const draft=store.salespersonOrder(business.id,partial);
  assert.equal(store.salespersonOrder(other.id,{action:'get_draft',id}).draft,null);
  assert.equal(store.salespersonOrder(business.id,{action:'get_draft',id}).order.products[0].product_name,'Imported Title');
  assert.equal(store.visibleRows('orders',follower.id).find(row=>row.id===id).current_step,'sales_supplement');
  assert.equal(store.visibleRows('order_images',other.id).some(row=>row.object_path===path),false);
  assert.equal(store.canUploadShopifyProductImage(other.id,path),false);
  assert.throws(()=>store.salespersonOrder(other.id,partial),/图片无效/);
  store.salespersonOrder(other.id,{...partial,products:[{product_name:'另一份草稿',image_paths:[otherPhoto]}]});
  const product={...fields(),requirements:'加急',image_paths:[path]};
  assert.equal(store.shopifyHandoff(business.id,{action:'place',id,business_name:'Demi',products:[product],draft_updated_at:draft.updated_at}).current_step,'follower_create');
  assert.deepEqual(store.salespersonOrder(other.id,{action:'list_drafts'}),[]);
  assert.equal(store.canReadObject(follower.id,path),true);
  assert.equal(store.canReadObject(follower.id,otherPhoto),false);
});

test('custom order numbers reject digits only, including a leading hash', () => {
  assert.equal(isPurelyNumericOrderNumber('9052'), true);
  assert.equal(isPurelyNumericOrderNumber('#9052'), true);
  assert.equal(isPurelyNumericOrderNumber('  #9052  '), true);
  assert.equal(isPurelyNumericOrderNumber('IZ-9052'), false);
  assert.equal(isPurelyNumericOrderNumber('#IZ-9052'), false);
  assert.equal(isPurelyNumericOrderNumber('9052A'), false);
  assert.equal(CUSTOM_ORDER_NUMBER_RULE, '不能是纯数字，也不能是纯 # 加数字');
});

test('a salesperson 新建下单 lands in 待跟单创建订单 for everyone, without an official order date', t => {
  const { store, business, other, rayna, follower, supervisor } = fixture(t);
  assert.throws(() => store.salespersonOrder(follower.id, { action: 'draft' }), error => error.status === 403);
  assert.throws(() => store.salespersonOrder(supervisor.id, { action: 'draft' }), error => error.status === 403);
  const draft = store.salespersonOrder(business.id, { action: 'draft' });
  assert.equal(store.visibleRows('orders', business.id).some(row => row.id === draft.id), false);
  assert.equal(store.visibleRows('orders', supervisor.id).some(row => row.id === draft.id), false);
  assert.equal(store.canUploadShopifyProductImage(business.id, `${draft.id}/product-image-photo.jpg`), true);
  assert.equal(store.canUploadShopifyProductImage(other.id, `${draft.id}/product-image-photo.jpg`), false);
  assert.throws(() => store.salespersonOrder(business.id, { action: 'place', id: draft.id, ...fields({ order_no: 'IZ-200' }) }), error => error.status === 400 && /图片/.test(error.message));
  attachImage(store, draft.id);
  for (const order_no of ['9052', '#9052', '  #9052  ']) {
    assert.throws(() => store.salespersonOrder(business.id, { action: 'place', id: draft.id, ...fields({ order_no }) }), error => error.status === 400 && error.message === '自定义订单号' + CUSTOM_ORDER_NUMBER_RULE);
  }
  assert.throws(() => store.salespersonOrder(business.id, { action: 'place', id: draft.id, ...fields({ order_no: 'IZ-200', abnormal_note: '' }) }), error => error.status === 400);
  store.put('orders', { id: 'taken', order_no: 'IZ-100', business_name: 'Sherry', business_id: other.id, current_step: 'production' });
  assert.throws(() => store.salespersonOrder(business.id, { action: 'place', id: draft.id, ...fields({ order_no: '#iz-100' }) }), error => error.status === 409);
  assert.throws(() => store.salespersonOrder(follower.id, { action: 'place', id: draft.id, ...fields({ order_no: 'IZ-200' }) }), error => error.status === 403);
  const placed = store.salespersonOrder(business.id, { action: 'place', id: draft.id, ...fields({ order_no: 'IZ-200', order_date: '2020-01-01' }) });
  const waiting = store.all('orders').find(row => row.id === placed.id);
  assert.equal(waiting.current_step, 'follower_create');
  assert.equal(waiting.order_no, 'IZ-200');
  assert.equal(waiting.order_date, undefined);
  assert.equal(waiting.shopify_order_id, undefined);
  assert.equal(waiting.business_id, business.id);
  assert.equal(waiting.blower, '包风机');
  assert.equal(store.canReadOrder(other.id, waiting), true);
  assert.equal(store.canReadOrder(rayna.id, waiting), true);
  assert.equal(store.canReadOrder(follower.id, waiting), true);
  assert.equal(store.visibleRows('orders', rayna.id).some(row => row.id === waiting.id), true);
  const shopifyWaiting = store.put('orders', { id: 'shop-wait', order_no: '#9080', shopify_order_id: 'gid://shopify/Order/9080', current_step: 'follower_create', business_name: 'Demi', business_id: business.id });
  assert.equal(store.canReadOrder(rayna.id, shopifyWaiting), false);
  const later = store.put('orders', { id: 'later-shared', order_no: 'LATER-1', current_step: 'production', salesperson_shared: true, business_name: 'Demi', business_id: business.id });
  assert.equal(store.canReadOrder(rayna.id, later), false);
  assert.throws(() => store.mutate('orders', 'POST', new URL('http://local/rest/v1/orders'), { order_no: 'X-1', current_step: 'follower_create' }, follower.id), error => error.status === 403);
  store.put('partners', { id: 'factory-a', kind: 'factory', name: 'Factory A', active: true });
  store.shopifyHandoff(supervisor.id, { action: 'assign_factory', id: waiting.id, factory_name: 'Factory A' });
  const beforeCreate = Date.now();
  const created = store.shopifyHandoff(follower.id, {
    action: 'create', id: waiting.id, order_no: 'IZ-200', order_date: '2020-01-01', product_name: 'Castle',
    size: '3 x 2 m', quantity: 2, customer_info: 'Ada\n1 Main St, Austin, TX 78701\nada@example.com\n+1 5551234567', business_name: 'Demi', destination_country: '美国',
    inventory_mode: 'production', needs_rendering: false, shipping_mode: 'domestic_sea', blower: '包风机',
    requirements: '请加急', factory_name: 'Factory A', factory_names: ['Factory A'], current_step: 'production'
  });
  const order = store.all('orders').find(row => row.id === created.id);
  assert.equal(order.current_step, 'business_placed');
  assert.equal(order.order_date, beijingOrderDate());
  assert.notEqual(order.order_date, '2020-01-01');
  assert.equal(order.shopify_order_id, undefined);
  const started = Date.parse(order.step_started_at);
  assert.ok(started >= beforeCreate && started <= Date.now());
  assert.equal(order.step_deadline, null);
  assert.equal(store.canReadOrder(rayna.id, order), false);
  assert.equal(store.canReadOrder(business.id, order), true);
  assert.equal(store.canReadOrder(follower.id, order), true);
  const manual = store.mutate('orders', 'POST', new URL('http://local/rest/v1/orders'), {
    order_no: 'MANUAL-9', order_date: '2026-11-22', product_name: 'Manual', quantity: 1, business_name: 'Demi', current_step: 'production',
    customer_info: 'Ada\n1 Main St, Austin, TX 78701\nada@example.com\n+1 5551234567'
  }, follower.id)[0];
  assert.equal(manual.order_date, '2026-11-22');
  assert.equal(manual.current_step, 'production');
  const shopify = store.importShopifyOrder({ id: 'gid://shopify/Order/9052', order_no: '#9052', product_name: 'Mat', quantity: 1, image_urls: ['https://cdn.shopify.com/9052.jpg'] });
  store.shopifyHandoff(business.id, { action: 'place', id: shopify.id, order_no: '#9052', product_name: '垫子', quantity: 1, business_name: 'Demi', shipping_mode: 'other', blower: '包风机', customer_info: 'Ada\n1 Main St, Austin, TX 78701\nada@example.com\n+1 5551234567', abnormal_note: '备注' });
  assert.equal(store.all('orders').find(row => row.id === shopify.id).order_no, '#9052');
});

test('the salesperson button and custom-number label stay separate from Shopify and merchandiser forms', () => {
  const app = readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');
  assert.match(app, /profile\?\.role==='business'\?`<button class="primary compact-new-order" id="newSalesOrder">＋ 新建下单<\/button><button[^>]*id="salespersonDrafts">我的草稿<\/button>/);
  assert.match(app, /id="newOrder">＋ 创建订单/);
  assert.match(app, /<label>自定义订单号 \*<input name="order_no" required><small class="order-no-hint">不能是纯数字，也不能是纯 # 加数字<\/small><span class="order-no-reminder" hidden><\/span><\/label>/);
  assert.match(app, /<label>后台订单号 \*<input name="order_no" required value="/);
  assert.match(app, /<button class="primary" type="submit" disabled>下单<\/button>/);
  assert.match(app, /salespersonOrderForm[\s\S]*bindSalespersonDraftForm\(form/);
  assert.match(app, /<h2>待业务员认领下单<\/h2>/);
  assert.match(app, /自定义订单号不能是纯数字，也不能是纯 # 加数字/);
  const shopifyForm = app.slice(app.indexOf('function openShopifyPlace'), app.indexOf('function openShopifyCreate'));
  assert.equal(shopifyForm.includes('不能是纯数字，也不能是纯 # 加数字'), false);
  assert.equal(app.includes('后台订单号不能是纯数字'), false);
  assert.match(app, /客户地址和联系信息 \*<textarea name="customer_info" required><\/textarea><small class="customer-info-hint">必须包含地址、邮箱和电话<\/small>/);
  assert.match(app, /客户地址和联系信息 \*<textarea name="customer_info" required>\$\{esc\(o\.customer_info\|\|''\)\}<\/textarea><small class="customer-info-hint">必须包含地址、邮箱和电话<\/small>/);
  assert.match(app, /customerRule\?'<small class="customer-info-hint">必须包含地址、邮箱和电话<\/small>/);
  assert.match(app, /openSalespersonOrder[\s\S]*bindCustomerInfoRule\(form\)/);
  assert.match(app, /openShopifyPlace[\s\S]*bindCustomerInfoRule\(form\)/);
  assert.match(app, /orderForm\(true,true\)/);
  const edit = app.slice(app.indexOf('function editExisting'), app.indexOf('function editExisting') + 1800);
  assert.equal(edit.includes('bindCustomerInfoRule'), false);
  assert.equal(edit.includes('customerInfoReminder'), false);
});

test('manual multi-product orders preserve line quantities, requirements and independent uploaded images', t => {
  const {store,business,follower,supervisor}=fixture(t);
  const {id}=store.salespersonOrder(business.id,{action:'draft'});
  const photoA=id+'/product-image-a.jpg', photoB=id+'/product-image-b.jpg';
  for(const object_path of [photoA,photoB])store.put('order_images',{order_id:id,object_path});
  const products=[
    {product_name:'城堡',quantity:2,size:'3 米',blower:'包风机',requirements:'红色',image_paths:[photoA]},
    {product_name:'拱门 Arch',quantity:3,size:'5 米',blower:'不包气泵',requirements:'蓝色',image_paths:[photoB]}
  ];
  const {abnormal_note: _note, ...common}=fields({order_no:'MULTI-1'});
  assert.throws(()=>store.salespersonOrder(business.id,{...common,action:'place',id,products:[{...products[0],image_paths:['other/product-image.jpg']}]}),/图片无效/);
  assert.throws(()=>store.salespersonOrder(business.id,{...common,action:'place',id,products:[products[0],{...products[1],requirements:''}]}),/第 2 行/);
  assert.throws(()=>store.salespersonOrder(business.id,{...common,action:'place',id,products:[products[0],{...products[1],product_name:'Arch'}]}),/产品名称须含中文/);
  store.salespersonOrder(business.id,{...common,action:'place',id,products});
  const saved=store.all('orders').find(order=>order.id===id);
  assert.equal(saved.quantity,5);
  assert.equal(saved.products[1].product_name,'拱门 Arch');
  assert.deepEqual(saved.products.map(row=>[row.requirements,row.image_paths[0]]),[['红色',photoA],['蓝色',photoB]]);
  store.shopifyHandoff(supervisor.id,{action:'assign_factory',id,factory_name:'库存'});
  store.shopifyHandoff(follower.id,{...common,action:'create',id,factory_name:'库存',destination_country:'美国',current_step:'production'});
  const official=store.all('orders').find(order=>order.id===id);
  assert.equal(official.quantity,5);
  assert.deepEqual(official.products,saved.products);
});
