import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import {
  FACTORY_EXPORT_COLUMNS, FACTORY_EXPORT_EMPTY_MESSAGE, FACTORY_EXPORT_EXCLUDED_STEPS, FACTORY_EXPORT_SHEET, FACTORY_IMAGE_SHEET,
  buildFactoryOrderWorkbook, canUseFactoryExport, createFactoryExportQueue, factoryExportFilename, factoryExportRows,
  factoryImageExtension, factoryImageSources, isFactoryExportable, officialOrderDate
} from '../factory-order-export.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function created(extra = {}) {
  return {
    id: 'order-1', order_no: 'IZ-200', order_date: '2026-11-22', product_name: 'Castle / Mat',
    size: '3 x 2 m / 2 x 1 m', quantity: 2, requirements: '请加急', current_step: 'production',
    step_deadline: '2026-12-01T00:00:00.000Z', created_at: '2020-01-01T00:00:00.000Z',
    customer_info: 'DO-NOT-EXPORT', abnormal_note: 'DO-NOT-EXPORT-NOTE', ...extra
  };
}

async function readWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook.getWorksheet(FACTORY_EXPORT_SHEET);
}

test('a slow image occupies only one slot and does not block the next order', async () => {
  const enqueue = createFactoryExportQueue(2);
  let releaseSlow, releaseSecond;
  const first = new Promise(resolve => { releaseSlow = resolve; });
  const second = new Promise(resolve => { releaseSecond = resolve; });
  const started = [];
  const slow = enqueue(() => { started.push('slow'); return first; });
  const fast = enqueue(() => { started.push('fast'); return second; });
  const next = enqueue(() => { started.push('next order'); return 'ready'; });
  await Promise.resolve();
  assert.deepEqual(started, ['slow', 'fast']);
  releaseSecond();
  assert.equal(await next, 'ready');
  assert.deepEqual(started, ['slow', 'fast', 'next order']);
  releaseSlow();
  await Promise.all([slow, fast]);
});

test('only a merchandiser role can use the factory export', () => {
  assert.equal(canUseFactoryExport({ role: 'follower' }), true);
  assert.equal(canUseFactoryExport({ role: 'follower', email: '505863160@qq.com' }), true);
  assert.equal(canUseFactoryExport({ role: 'business' }), false);
  assert.equal(canUseFactoryExport({ role: 'business', email: '505863160@qq.com' }), false);
  assert.equal(canUseFactoryExport(null), false);
  assert.equal(canUseFactoryExport({}), false);
});

test('drafts waiting on the salesperson or merchandiser are not exportable', () => {
  for (const current_step of FACTORY_EXPORT_EXCLUDED_STEPS) {
    assert.equal(isFactoryExportable(created({ current_step })), false);
    assert.deepEqual(factoryExportRows(created({ current_step })), []);
  }
  assert.equal(isFactoryExportable(created({ deleted_at: '2026-11-22T00:00:00.000Z' })), false);
  assert.equal(isFactoryExportable(created({ current_step: '' })), false);
  assert.equal(isFactoryExportable(created({ current_step: 'business_placed' })), true);
  assert.equal(isFactoryExportable(created({ current_step: 'completed' })), true);
});

test('one stored product is one row, and a joined Shopify name is not split', () => {
  const rows = factoryExportRows(created());
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['产品名称'], 'Castle / Mat');
  assert.equal(rows[0]['尺寸'], '3 x 2 m / 2 x 1 m');
  assert.equal(rows[0]['数量'], 2);
  assert.equal(Object.hasOwn(rows[0], '订单号'), false);
  assert.equal(JSON.stringify(rows[0]).includes('IZ-200'), false);
  assert.deepEqual(Object.keys(rows[0]), FACTORY_EXPORT_COLUMNS.filter(column => !['产品图片', '图片URL'].includes(column)));
});

test('下单日期 is the stored order_date and 交货日期 stays blank', () => {
  const row = factoryExportRows(created({
    order_date: '2026-11-22', created_at: '2020-01-01T16:00:00.000Z',
    step_deadline: '2026-12-31T00:00:00.000Z', shipped_at: '2026-12-02', due_date: '2026-12-15'
  }))[0];
  assert.equal(officialOrderDate(created({ order_date: '2026-11-22' })), '2026-11-22');
  assert.equal(row['下单日期'], '2026-11-22');
  assert.equal(row['交货日期'], '');
  assert.equal(row['下单要求'], '请加急');
  assert.equal(JSON.stringify(row).includes('DO-NOT-EXPORT'), false);
  assert.equal(JSON.stringify(row).includes('2020-01-01'), false);
  assert.equal(JSON.stringify(row).includes('2026-12-31'), false);
  assert.equal(officialOrderDate(created({ order_date: '2026-11-22T00:00:00.000Z' })), '');
});

test('workbook keeps every photo and clickable URL with normal row heights', async () => {
  const early = created({ id: 'early', order_no: 'IZ-100', order_date: '2026-11-20', product_name: 'Arch', quantity: 1, requirements: '普通', size: '1 m' });
  const later = created({ id: 'later', order_no: 'IZ-300' });
  const url = 'https://cdn.shopify.com/s/files/1/' + 'product-long-name-'.repeat(11) + 'large.png?v=1';
  const many = Array.from({length: 18}, (_, index) => ({buffer: PNG, extension: 'png', url: url + '&image=' + index, width: 400, height: 250}));
  const unavailable = 'https://cdn.shopify.com/unavailable.png';
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildFactoryOrderWorkbook(
    [later, created({ current_step: 'sales_supplement' }), early],
    new Map([['later', many], ['early', [{ url: unavailable, text: '图片暂无法嵌入' }]]])
  ));
  const sheet = workbook.getWorksheet(FACTORY_EXPORT_SHEET);
  const detail = workbook.getWorksheet(FACTORY_IMAGE_SHEET);
  assert.deepEqual(sheet.getRow(1).values.slice(1), [...FACTORY_EXPORT_COLUMNS]);
  assert.equal(sheet.rowCount, 3);
  assert.equal(sheet.getRow(2).getCell(8).value.hyperlink, unavailable);
  assert.equal(sheet.getRow(3).getCell(7).value, '');
  assert.match(sheet.getRow(3).getCell(8).value, /图片明细.*18 张/);
  assert.equal(sheet.getImages().length, 12);
  assert.equal(detail.getImages().length, 18);
  assert.equal(detail.rowCount, 20);
  assert.equal(detail.getRow(2).getCell(5).value.hyperlink, unavailable);
  assert.equal(detail.getRow(2).getCell(6).value, '图片暂无法嵌入');
  many.forEach(({url}, index) => {
    const row = detail.getRow(index + 3);
    assert.equal(row.getCell(1).value, 3);
    assert.equal(row.getCell(3).value, index + 1);
    assert.deepEqual(row.getCell(5).value, { text: url, hyperlink: url });
    assert.ok(row.height > 70 && row.height <= 409);
  });
  assertPhotoBounds(sheet, 3);
  assertPhotoBounds(detail, 4);
  assert.equal(workbook.model.media.length, 1);
  const dumped = JSON.stringify([sheet.getRow(1).values, sheet.getRow(2).values, sheet.getRow(3).values]);
  for (const excluded of ['订单号', 'IZ-100', 'IZ-300', 'DO-NOT-EXPORT', '2026-12-01']) assert.ok(!dumped.includes(excluded));
});

function assertPhotoBounds(sheet, column) {
  const rectangles = new Map();
  for (const image of sheet.getImages()) {
    const { tl, ext } = image.range;
    const row = sheet.getRow(tl.nativeRow + 1);
    const left = tl.nativeColOff / 9525, top = tl.nativeRowOff / 9525;
    const rect = {left, top, right:left+ext.width, bottom:top+ext.height};
    assert.equal(tl.nativeCol, column - 1);
    assert.ok(rect.right <= sheet.getColumn(column).width * 7);
    assert.ok(rect.bottom * .75 <= row.height);
    assert.ok(Math.abs(ext.width / ext.height - 1.6) < .01);
    for (const other of rectangles.get(row.number) || []) {
      assert.ok(rect.right <= other.left || rect.left >= other.right || rect.bottom <= other.top || rect.top >= other.bottom);
    }
    rectangles.set(row.number, [...(rectangles.get(row.number) || []), rect]);
  }
}

test('a single embedded photo also has its full URL in the order sheet', async () => {
  const url = 'https://cdn.shopify.com/castle.png?v=7';
  const sheet = await readWorkbook(await buildFactoryOrderWorkbook([created()], new Map([
    ['order-1', [{ buffer: PNG, extension: 'png', url }]]
  ])));
  assert.equal(sheet.getImages().length, 1);
  assert.deepEqual(sheet.getRow(2).getCell(8).value, { text: url, hyperlink: url });
  assert.equal(sheet.getRow(2).getCell(7).value, '');
});

test('an empty selection does not build a workbook', async () => {
  await assert.rejects(
    () => buildFactoryOrderWorkbook([created({ current_step: 'follower_create' }), created({ current_step: 'sales_supplement' })]),
    error => error.code === 'empty-factory-export' && error.message === FACTORY_EXPORT_EMPTY_MESSAGE
  );
});

test('product image sources keep https photos and drop proofs and insecure urls', () => {
  const sources = factoryImageSources(created({
    shopify_image_urls: ['https://cdn.shopify.com/a.jpg', 'http://insecure.example/x.jpg', 'https://cdn.shopify.com/a.jpg'],
    image_urls: ['https://cdn.shopify.com/b.jpg']
  }), [
    { object_path: 'order-1/product-image-photo.jpg', url: 'https://kis.net/storage/v1/object/order-images/photo?token=1' },
    { object_path: 'order-1/delivery-proof-photo.jpg', url: 'https://kis.net/storage/v1/object/order-images/proof?token=1' },
    { object_path: 'order-1/other.jpg', url: 'https://kis.net/storage/v1/object/order-images/other?token=1' }
  ]);
  assert.deepEqual(sources.map(source => source.publicUrl), ['https://cdn.shopify.com/a.jpg', 'https://cdn.shopify.com/b.jpg', 'https://kis.net/storage/v1/object/order-images/photo?token=1']);
  assert.equal(sources[2].fetchUrl.includes('product-image') === false, true);
  assert.equal(sources.some(source => source.fetchUrl.includes('proof')), false);
  assert.equal(factoryImageExtension(PNG, 'image/png'), 'png');
  assert.equal(factoryImageExtension(PNG, 'text/html'), '');
  assert.equal(factoryImageExtension(new Uint8Array([0xff, 0xd8, 0xff, 0]), ''), 'jpeg');
});

test('filename uses the Beijing date and no customer name', () => {
  assert.equal(factoryExportFilename(new Date('2026-11-21T16:30:00.000Z')), '工厂下单文件-2026-11-22.xlsx');
  assert.equal(factoryExportFilename(new Date('2026-11-21T15:30:00.000Z')), '工厂下单文件-2026-11-21.xlsx');
  assert.equal(factoryExportFilename().includes('DO-NOT-EXPORT'), false);
});

test('the order list shows the export only to merchandisers', () => {
  const app = readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');
  const follower = app.slice(app.indexOf('${follower?`'), app.indexOf('`:""}${profile?.role===\'business\''));
  const business = app.slice(app.indexOf('${profile?.role===\'business\'?`'), app.indexOf('<div class="index-filters">'));
  assert.match(follower, /id="newOrder">＋ 创建订单/);
  assert.match(follower, /id="exportFactoryOrders"/);
  assert.match(follower, /id="selectFactoryOrdersPage"/);
  assert.equal(business.includes('exportFactoryOrders'), false);
  assert.equal(business.includes('selectFactoryOrdersPage'), false);
  assert.equal(business.includes('factory-export'), false);
  assert.match(app, /canFollowOrders\(\)&&isFactoryExportable\(o\)\?`<span class="order-no-wrap"><label class="factory-export-check">/);
  assert.match(app, /if\(event\.target\.closest\?\.\('\.factory-export-check,#exportFactoryOrders,#selectFactoryOrdersPage'\)\)return/);
  assert.match(app, /if\(event\.target\.closest\?\.\('\.factory-export-check'\)\)return/);
  const exportFn = app.slice(app.indexOf('async function exportSelectedFactoryOrders'), app.indexOf('function normalizeForwarderName'));
  assert.match(exportFn, /if\(!canFollowOrders\(\)\|\|!canUseFactoryExport\(profile\)\)return/);
  assert.match(exportFn, /isFactoryExportable\(order\)/);
  assert.match(exportFn, /alert\(FACTORY_EXPORT_EMPTY_MESSAGE\)/);
  assert.match(exportFn, /factoryExportFilename\(\)/);
  assert.equal(exportFn.includes('customer_info'), false);
  assert.equal(exportFn.includes('/rpc/'), false);
  assert.match(app, /factory-order-export\.js\?v=20261122-10/);
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /\/app-v2\.js\?v=20261123-8"/);
});
