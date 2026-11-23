import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { TencentDataStore } from '../server/tencent-data-core.mjs';

const CUSTOMER = 'Ada\n1 Main St, Austin, TX 78701\nada@example.com\n+1 5551234567';
const IMAGE_A = 'https://cdn.shopify.com/a.jpg';
const IMAGE_B = 'https://cdn.shopify.com/b.jpg';
const IMAGE_C = 'https://cdn.shopify.com/c.jpg';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cargo-product-images-'));
  const store = new TencentDataStore(join(dir, 'db.sqlite'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const business = store.upsertAccount({ email: 'demi@inflatable-zone.com', role: 'business' });
  const other = store.upsertAccount({ email: 'sherry@inflatable-zone.com', role: 'business' });
  const ella = store.upsertAccount({ email: 'sales@inflatable-zone.com', role: 'business' });
  const follower = store.upsertAccount({ email: 'follow@example.com', role: 'follower' });
  const supervisor = store.upsertAccount({ email: '505863160@qq.com', role: 'follower' });
  return { store, business, other, ella, follower, supervisor };
}

function supplementFields(extra = {}) {
  return {
    product_name: 'Castle', quantity: 2, size: '3 x 2 m', business_name: 'Demi',
    shipping_mode: 'domestic_sea', blower: '包风机', customer_info: CUSTOMER, abnormal_note: '请加急',
    ...extra
  };
}

function importWaiting(store, extra = {}) {
  return store.importShopifyOrder({
    id: 'gid://shopify/Order/9101', order_no: '#9101', order_date: '2026-11-22', product_name: 'Arch', quantity: 2,
    image_urls: [IMAGE_A, IMAGE_B], customer_info: 'Ada', shipping_mode: 'domestic_express', blower: '气泵',
    ...extra
  });
}

function addUpload(store, order, name = 'photo.jpg') {
  const object_path = `${order.id}/product-image-${name}`;
  store.put('order_images', { order_id: order.id, object_path, file_name: '产品图片 · ' + name });
  return object_path;
}

test('before 下单 a salesperson can delete a Shopify image and an uploaded image, and they stay gone', t => {
  const { store, business, other, follower, supervisor } = fixture(t);
  const waiting = importWaiting(store);
  assert.equal(waiting.current_step, 'sales_supplement');
  assert.deepEqual(waiting.shopify_image_urls, [IMAGE_A, IMAGE_B]);
  const upload = addUpload(store, waiting, 'one.jpg');
  const kept = addUpload(store, waiting, 'two.jpg');
  store.put('order_images', { order_id: waiting.id, object_path: `${waiting.id}/delivery-proof-photo.jpg`, file_name: '签收证明' });
  assert.throws(() => store.removeSalespersonProductImage(follower.id, { id: waiting.id, image_url: IMAGE_A }), error => error.status === 403);
  assert.throws(() => store.removeSalespersonProductImage(supervisor.id, { id: waiting.id, image_url: IMAGE_A }), error => error.status === 403);
  assert.throws(() => store.removeSalespersonProductImage(business.id, { id: waiting.id, image_url: IMAGE_A, object_path: upload }), error => error.status === 400);
  assert.throws(() => store.removeSalespersonProductImage(business.id, { id: waiting.id, image_url: 'http://cdn.shopify.com/a.jpg' }), error => error.status === 400);
  assert.throws(() => store.removeSalespersonProductImage(business.id, { id: waiting.id, object_path: `${waiting.id}/delivery-proof-photo.jpg` }), error => error.status === 403);
  const otherOrder = store.importShopifyOrder({ id: 'gid://shopify/Order/9102', order_no: '#9102', product_name: 'Other', quantity: 1, image_urls: [IMAGE_C] });
  const foreign = addUpload(store, otherOrder, 'foreign.jpg');
  assert.throws(() => store.removeSalespersonProductImage(business.id, { id: waiting.id, object_path: foreign }), error => error.status === 403);
  assert.throws(() => store.mutate('order_images', 'DELETE', new URL('http://local/rest/v1/order_images?order_id=eq.' + waiting.id), {}, business.id), error => error.status === 403);

  const removedUrl = store.removeSalespersonProductImage(other.id, { id: waiting.id, image_url: IMAGE_A });
  assert.deepEqual(removedUrl.shopify_image_urls, [IMAGE_B]);
  const removedFile = store.removeSalespersonProductImage(business.id, { id: waiting.id, object_path: upload });
  assert.equal(removedFile.removed, true);
  const order = store.all('orders').find(row => row.id === waiting.id);
  assert.equal(order.current_step, 'sales_supplement');
  assert.equal(order.product_name, 'Arch');
  assert.deepEqual(order.shopify_image_urls, [IMAGE_B]);
  assert.deepEqual(order.dismissed_shopify_image_urls, [IMAGE_A]);
  const images = store.all('order_images').filter(row => row.order_id === waiting.id).map(row => row.object_path);
  assert.deepEqual(images.sort(), [`${waiting.id}/delivery-proof-photo.jpg`, kept].sort());
  assert.equal(store.userNotifications(follower.id, { action: 'list' }).unread_count, 0);
  assert.throws(() => store.removeSalespersonProductImage(business.id, { id: waiting.id, image_url: IMAGE_A }), error => error.status === 404);

  const reopened = store.all('orders').find(row => row.id === waiting.id);
  assert.equal(reopened.shopify_image_urls.includes(IMAGE_A), false);
  assert.equal(store.all('order_images').some(row => row.object_path === upload), false);
  const placed = store.shopifyHandoff(business.id, { action: 'place', id: waiting.id, order_no: '#9101', ...supplementFields(), shopify_image_urls: reopened.shopify_image_urls });
  const afterPlace = store.all('orders').find(row => row.id === placed.id);
  assert.equal(afterPlace.current_step, 'follower_create');
  assert.deepEqual(afterPlace.shopify_image_urls, [IMAGE_B]);
  assert.equal(store.all('order_images').some(row => row.object_path === kept), true);
});

test('a later Shopify refresh does not restore a product image deleted before 下单', t => {
  const { store, business } = fixture(t);
  const waiting = importWaiting(store);
  const stored = store.all('orders').find(row => row.id === waiting.id);
  delete stored.shopify_source_refreshed_at;
  stored.image_urls = [IMAGE_A, IMAGE_B];
  store.put('orders', stored);
  store.removeSalespersonProductImage(business.id, { id: waiting.id, image_url: IMAGE_A });
  const refreshed = store.importShopifyOrder({
    id: waiting.shopify_order_id, order_no: '#9101', product_name: 'Arch', quantity: 2,
    image_urls: [IMAGE_A, IMAGE_B, IMAGE_C]
  });
  assert.deepEqual(refreshed.shopify_image_urls, [IMAGE_B, IMAGE_C]);
  assert.equal(refreshed.image_urls.includes(IMAGE_A), false);
  assert.equal(refreshed.current_step, 'sales_supplement');
  assert.equal(store.importShopifyOrder({ id: waiting.shopify_order_id, order_no: '#9101', product_name: 'Again', image_urls: [IMAGE_A, IMAGE_B, IMAGE_C] }), null);
  assert.deepEqual(store.all('orders').find(row => row.id === waiting.id).shopify_image_urls, [IMAGE_B, IMAGE_C]);
});

test('after 下单 and after 创建订单 only that order salesperson can delete product images', t => {
  const { store, business, other, ella, follower, supervisor } = fixture(t);
  const waiting = importWaiting(store);
  const upload = addUpload(store, waiting, 'kept.jpg');
  store.shopifyHandoff(business.id, { action: 'place', id: waiting.id, order_no: '#9101', ...supplementFields() });
  assert.throws(() => store.removeSalespersonProductImage(other.id, { id: waiting.id, image_url: IMAGE_A }), error => error.status === 403);
  assert.throws(() => store.removeSalespersonProductImage(ella.id, { id: waiting.id, image_url: IMAGE_A }), error => error.status === 403);
  assert.throws(() => store.removeSalespersonProductImage(follower.id, { id: waiting.id, object_path: upload }), error => error.status === 403);
  assert.throws(() => store.removeSalespersonProductImage(supervisor.id, { id: waiting.id, image_url: IMAGE_B }), error => error.status === 403);
  store.removeSalespersonProductImage(business.id, { id: waiting.id, image_url: IMAGE_A });
  const waitingOrder = store.all('orders').find(row => row.id === waiting.id);
  assert.equal(waitingOrder.current_step, 'follower_create');
  assert.deepEqual(waitingOrder.shopify_image_urls, [IMAGE_B]);
  assert.equal(store.userNotifications(follower.id, { action: 'list' }).unread_count, 0);
  store.put('partners', { id: 'factory-a', kind: 'factory', name: 'Factory A', active: true });
  store.shopifyHandoff(supervisor.id, { action: 'assign_factory', id: waiting.id, factory_name: 'Factory A' });

  const created = store.shopifyHandoff(follower.id, {
    action: 'create', id: waiting.id, order_no: '#9101', product_name: 'Castle', size: '3 x 2 m', quantity: 2,
    customer_info: CUSTOMER, business_name: 'Demi', destination_country: '美国', inventory_mode: 'production',
    needs_rendering: false, shipping_mode: 'domestic_sea', blower: '包风机', requirements: '跟单单独要求',
    factory_name: 'Factory A', factory_names: ['Factory A'], current_step: 'production'
  });
  assert.equal(created.current_step, 'production');
  const beforeDelete = store.all('orders').find(row => row.id === created.id);
  store.removeSalespersonProductImage(business.id, { id: created.id, image_url: IMAGE_B });
  store.removeSalespersonProductImage(business.id, { id: created.id, object_path: upload });
  const issued = store.all('orders').find(row => row.id === created.id);
  assert.equal(issued.current_step, 'production');
  assert.equal(issued.requirements, '跟单单独要求');
  assert.equal(issued.order_date, beforeDelete.order_date);
  assert.equal(issued.factory_name, 'Factory A');
  assert.deepEqual(issued.shopify_image_urls, []);
  assert.equal(store.all('order_images').some(row => row.object_path === upload), false);
  assert.equal(store.userNotifications(follower.id, { action: 'list' }).unread_count, 0);
  const saved = store.updateSalespersonSupplement(business.id, { id: issued.id, ...supplementFields({ product_name: 'Castle revised' }) });
  assert.equal(store.all('orders').find(row => row.id === saved.id).product_name, 'Castle revised');
  assert.deepEqual(store.all('orders').find(row => row.id === saved.id).shopify_image_urls, []);
  assert.equal(store.userNotifications(follower.id, { action: 'list' }).unread_count, 1);
});

function domNode(tag) {
  const node = {
    tag,
    children: [],
    className: '',
    textContent: '',
    attributes: {},
    listeners: {},
    parent: null,
    removed: false,
    append(...kids) {
      for (const kid of kids) {
        kid.parent = node;
        node.children.push(kid);
      }
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    remove() {
      this.removed = true;
      if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    },
    querySelector(selector) {
      const walk = current => {
        if (current.className.split(/\s+/).includes(selector.slice(1))) return current;
        for (const child of current.children) {
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return walk(this);
    }
  };
  return node;
}

test('clicking 删除 removes that thumbnail and asks the server to keep it deleted', async () => {
  const app = readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('function mountSalespersonProductImages'), app.indexOf('function openSalespersonSupplement'));
  const order = {
    id: 'order-1',
    shopify_image_urls: [IMAGE_A, 'http://insecure.example/x.jpg', IMAGE_B]
  };
  const cached = { id: 'order-1', shopify_image_urls: [...order.shopify_image_urls] };
  const orders = [cached];
  const calls = [];
  const api = async (path, opt = {}) => {
    const body = opt.body ? JSON.parse(opt.body) : null;
    calls.push({ path, body });
    if (String(path).includes('/order_images?')) {
      return [
        { object_path: 'order-1/product-image-one.jpg', file_name: '产品图片 · one.jpg' },
        { object_path: 'order-1/delivery-proof-photo.jpg', file_name: '签收证明' }
      ];
    }
    if (String(path).includes('/object/sign/')) return { signedURL: '/object/order-images/product-image-one.jpg?token=1' };
    if (body?.action === 'remove_image' && body.image_url) {
      return { shopify_image_urls: order.shopify_image_urls.filter(url => url !== body.image_url) };
    }
    if (body?.action === 'remove_image') return { removed: true, object_path: body.object_path };
    throw Error('unexpected ' + path);
  };
  const gallery = domNode('div');
  gallery.className = 'q-shopify-images';
  const error = domNode('p');
  error.className = 'error';
  const form = domNode('form');
  form.append(gallery, error);
  const document = { createElement: domNode };
  runInNewContext(source + '\nmountSalespersonProductImages(form, order);', {
    form, order, orders, api, document, cfg: { url: 'http://local' }
  });
  await form.salespersonImageEdits();
  const buttons = () => gallery.children.flatMap(frame => frame.children.filter(child => child.className === 'product-image-delete'));
  assert.equal(gallery.children.length, 3);
  assert.equal(buttons().length, 3);
  assert.equal(buttons().every(button => button.textContent === '删除' && button.attributes['aria-label'] === '删除图片' && button.type === 'button'), true);
  assert.equal(gallery.children.some(frame => frame.children.some(child => child.alt === 'Shopify 产品图片' && child.src === 'http://insecure.example/x.jpg')), false);
  assert.equal(gallery.children.some(frame => frame.children.some(child => String(child.src || '').includes('delivery-proof'))), false);

  const shopifyButton = buttons().find(button => button.parent.children.some(child => child.src === IMAGE_A));
  shopifyButton.listeners.click();
  await form.salespersonImageEdits();
  assert.equal(shopifyButton.parent.removed, true);
  assert.equal(gallery.children.some(frame => frame.children.some(child => child.src === IMAGE_A)), false);
  assert.equal(gallery.children.some(frame => frame.children.some(child => child.src === IMAGE_B)), true);
  assert.deepEqual(order.shopify_image_urls, ['http://insecure.example/x.jpg', IMAGE_B]);
  assert.deepEqual(cached.shopify_image_urls, order.shopify_image_urls);
  assert.equal(calls.some(call => call.body?.action === 'remove_image' && call.body.image_url === IMAGE_A && call.body.id === 'order-1'), true);

  const uploadButton = buttons().find(button => button.parent.children.some(child => String(child.src || '').includes('product-image-one')));
  uploadButton.listeners.click();
  await form.salespersonImageEdits();
  assert.equal(uploadButton.parent.removed, true);
  assert.equal(calls.some(call => call.body?.action === 'remove_image' && call.body.object_path === 'order-1/product-image-one.jpg'), true);
  assert.equal(gallery.children.length, 1);

  const retryOrder = { id: 'order-2', shopify_image_urls: [IMAGE_C] };
  const retryGallery = domNode('div');
  retryGallery.className = 'q-shopify-images';
  const retryError = domNode('p');
  retryError.className = 'error';
  const retryForm = domNode('form');
  retryForm.append(retryGallery, retryError);
  let failed = false;
  runInNewContext(source + '\nmountSalespersonProductImages(form, order);', {
    form: retryForm,
    order: retryOrder,
    orders: [retryOrder],
    api: async (path, opt = {}) => {
      const body = opt.body ? JSON.parse(opt.body) : null;
      if (body?.action === 'remove_image') {
        failed = true;
        throw Error('删除图片失败');
      }
      if (String(path).includes('/order_images?')) return [];
      return {};
    },
    document,
    cfg: { url: 'http://local' }
  });
  await retryForm.salespersonImageEdits();
  const retryButton = retryGallery.children[0].children.find(child => child.className === 'product-image-delete');
  retryButton.listeners.click();
  await retryForm.salespersonImageEdits();
  assert.equal(failed, true);
  assert.equal(retryGallery.children.length, 1);
  assert.equal(retryGallery.children[0].removed, false);
  assert.equal(retryButton.disabled, false);
  assert.equal(retryError.textContent, '删除图片失败');
  assert.deepEqual(retryOrder.shopify_image_urls, [IMAGE_C]);
});

test('the salesperson forms keep add and gain a delete control without changing the merchandiser create path', () => {
  const app = readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../server/tencent-data-server.mjs', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../product-image-delete.css', import.meta.url), 'utf8');
  const mount = app.slice(app.indexOf('function mountSalespersonProductImages'), app.indexOf('function openSalespersonSupplement'));
  const supplement = app.slice(app.indexOf('function openSalespersonSupplement'), app.indexOf('async function openSalespersonOrder'));
  const place = app.slice(app.indexOf('function openShopifyPlace'), app.indexOf('function openShopifyCreate'));
  const create = app.slice(app.indexOf('function openShopifyCreate'), app.indexOf('function detailHtml'));
  assert.match(mount, /button\.className='product-image-delete'/);
  assert.match(mount, /button\.textContent='删除'/);
  assert.match(mount, /aria-label','删除图片'/);
  assert.match(mount, /action:'remove_image',id:order\.id,image_url:url/);
  assert.match(mount, /action:'remove_image',id:order\.id,object_path:row\.object_path/);
  assert.match(mount, /includes\('\/product-image-'\)/);
  assert.match(supplement, /mountSalespersonProductImages\(d\.querySelector\('form'\),o\)/);
  assert.match(supplement, /添加图片（已有图片时可选）<input name="extra_images" type="file" accept="image\/\*" multiple>/);
  assert.match(supplement, /await form\.salespersonImageEdits\?\.\(\)/);
  assert.match(supplement, /for\(const file of form\.querySelector\('input\[type=file\]'\)\.files\)await uploadShopifyProductImage/);
  assert.match(place, /mountSalespersonProductImages\(d\.querySelector\('form'\),o\)/);
  assert.match(place, /<h2>待业务员补充信息<\/h2>/);
  assert.match(place, /添加图片（已有图片时可选）<input name="extra_images" type="file" accept="image\/\*" multiple>/);
  assert.match(place, /payload\.shopify_image_urls=/);
  assert.match(place, /action:'place'/);
  assert.equal(place.includes('name="image_urls"'), false);
  assert.match(create, /appendShopifyImages\(images,o\.shopify_image_urls\)/);
  assert.match(create, /showUploadedProductImages\(images,o\.id\)/);
  assert.equal(create.includes('mountSalespersonProductImages'), false);
  assert.equal(create.includes('product-image-delete'), false);
  assert.match(app, /current_step==='sales_supplement'&&profile\?\.role==='business'\)\{openShopifyPlace\(o\);return\}/);
  assert.match(app, /current_step==='follower_create'&&profile\?\.role==='business'&&isOrderSalesperson\(o\)\)\{openSalespersonSupplement\(o\);return\}/);
  assert.match(app, /#shopifyCreate'\)\?\.addEventListener\('click',\(\)=>openFollowerCreate\(o,d\)\)/);
  assert.match(app, /Ella<\/option>.*Sherry<\/option>.*Demi<\/option>.*Rayna<\/option>/);
  assert.match(page, /product-image-delete\.css/);
  assert.match(css, /\.product-image-delete/);
  assert.equal(readFileSync(new URL('../style-v2.css', import.meta.url), 'utf8').includes('product-image-delete'), false);
  assert.match(server, /body\.action === 'remove_image'/);
  assert.match(server, /unlink\(safeUploadPath\(removed\.object_path\)\)/);
  assert.match(server, /store\.updateSalespersonSupplement\(user\.id, body\)/);
});
