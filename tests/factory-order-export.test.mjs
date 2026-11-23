import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import {
  FACTORY_EXPORT_COLUMNS, FACTORY_EXPORT_EMPTY_MESSAGE, FACTORY_EXPORT_EXCLUDED_STEPS, FACTORY_EXPORT_SHEET,
  buildFactoryOrderWorkbook, canUseFactoryExport, factoryExportFilename, factoryExportRows,
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
  assert.deepEqual(Object.keys(rows[0]), FACTORY_EXPORT_COLUMNS.filter(column => column !== '产品图片'));
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

test('workbook columns, blank delivery date, images, and excluded orders', async () => {
  const early = created({ id: 'early', order_no: 'IZ-100', order_date: '2026-11-20', product_name: 'Arch', quantity: 1, requirements: '普通', size: '1 m' });
  const later = created({
    id: 'later', order_no: 'IZ-300', shopify_image_urls: ['https://cdn.shopify.com/castle.jpg', 'http://insecure.example/x.jpg']
  });
  const buffer = await buildFactoryOrderWorkbook(
    [later, created({ current_step: 'sales_supplement', order_no: 'WAIT-1' }), created({ current_step: 'follower_create', order_no: 'WAIT-2' }), early],
    new Map([
      ['later', [{ buffer: PNG, extension: 'png' }, { buffer: PNG, extension: 'jpeg' }, { url: 'https://cdn.shopify.com/castle.jpg' }]],
      ['early', [{ text: '产品图片未能嵌入' }]]
    ])
  );
  const sheet = await readWorkbook(buffer);
  assert.deepEqual(sheet.getRow(1).values.slice(1), [...FACTORY_EXPORT_COLUMNS]);
  assert.equal(sheet.columnCount, FACTORY_EXPORT_COLUMNS.length);
  assert.equal(sheet.rowCount, 3);
  const first = sheet.getRow(2).values.slice(1);
  const second = sheet.getRow(3).values.slice(1);
  assert.deepEqual(first, ['2026-11-20', 'Arch', '产品图片未能嵌入', '1 m', 1, '普通', '']);
  assert.equal(second[0], '2026-11-22');
  assert.equal(second[1], 'Castle / Mat');
  assert.equal(second[2].text, 'https://cdn.shopify.com/castle.jpg');
  assert.equal(second[2].hyperlink, 'https://cdn.shopify.com/castle.jpg');
  assert.equal(second[6], '');
  assert.equal(sheet.getRow(2).getCell(7).value, '');
  assert.equal(sheet.getRow(3).getCell(7).value, '');
  assert.equal(sheet.workbook.worksheets.length, 1);
  const images = sheet.getImages();
  assert.equal(images.length, 2);
  assert.equal(images.every(image => image.range.tl.nativeCol === 2 && image.range.tl.nativeRow === 2), true);
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7].map(index => sheet.getColumn(index).width),
    [14, 28, 46, 16, 10, 36, 14]
  );
  const imageCell = sheet.getRow(3).getCell(3);
  assert.equal(imageCell.alignment.vertical, 'bottom');
  assert.equal(imageCell.alignment.wrapText, true);
  assert.equal(sheet.getRow(2).getCell(3).alignment?.vertical === 'bottom', false);
  assertImagesSitAboveUrl(sheet, 3);
  const dumped = JSON.stringify([first, second, sheet.getRow(1).values]);
  assert.equal(dumped.includes('订单号'), false);
  assert.equal(dumped.includes('IZ-100'), false);
  assert.equal(dumped.includes('IZ-300'), false);
  assert.equal(dumped.includes('DO-NOT-EXPORT'), false);
  assert.equal(dumped.includes('WAIT-1'), false);
  assert.equal(dumped.includes('2026-12-01'), false);
});

const EMU_PER_PX = 9525;
const EMU_PER_PT = 12700;

function columnWidthPx(width) {
  const maxDigitWidth = 7;
  return Math.floor(((256 * width + Math.floor(128 / maxDigitWidth)) / 256) * maxDigitWidth);
}

// Bottom-aligned text occupies the last lines of the row. The picture must
// end before that block, including when the URL is long enough to wrap.
function assertImagesSitAboveUrl(sheet, rowNumber) {
  const row = sheet.getRow(rowNumber);
  const cell = row.getCell(3);
  const text = cell.value && typeof cell.value === 'object' ? String(cell.value.text || '') : String(cell.value || '');
  const capacity = Math.max(8, Math.floor(sheet.getColumn(3).width * 0.9));
  const lines = text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / capacity)), 0);
  const textPt = lines * 15;
  const pictures = sheet.getImages()
    .filter(image => image.range.tl.nativeRow === rowNumber - 1)
    .sort((a, b) => a.range.tl.nativeColOff - b.range.tl.nativeColOff);
  assert.ok(pictures.length > 0);
  const columnPx = columnWidthPx(sheet.getColumn(3).width);
  let previousRight = 0;
  for (const picture of pictures) {
    const leftPx = picture.range.tl.nativeColOff / EMU_PER_PX;
    const topPt = picture.range.tl.nativeRowOff / EMU_PER_PT;
    const sizePx = picture.range.ext.width;
    const bottomPt = topPt + (picture.range.ext.height * EMU_PER_PX) / EMU_PER_PT;
    assert.equal(picture.range.tl.nativeCol, 2);
    assert.ok(leftPx >= previousRight - 0.5, 'product photos overlap each other');
    assert.ok(leftPx + sizePx <= columnPx + 0.5, 'product photo spills out of 产品图片');
    assert.ok(row.height - textPt >= bottomPt + 4, `photo bottom ${bottomPt} meets URL text in a ${row.height}pt row`);
    previousRight = leftPx + sizePx;
  }
}

test('a long Shopify URL stays complete under the product photo', async () => {
  const url = 'https://cdn.shopify.com/s/files/1/0503/4324/8066/files/Mechanical_Bull_Rides_Inflatable_Bull_Rides_Rock_Bull_Rides_Electric_Bull_Riding_Machine_For_Amusement_Park.png?v=1';
  const linkedOnly = 'https://cdn.shopify.com/only-the-link.jpg';
  const buffer = await buildFactoryOrderWorkbook(
    [
      created({
        id: 'bull', order_no: 'BULL-1', order_date: '2026-11-23',
        product_name: 'Mechanical Bull Rides Inflatable Bull Rides Rock Bull Rides Electric Bull Riding Machine For Amusement Park - By sea door to door (production time 6 business days + shipping time 39 business days) / With air blower',
        size: '6x4M', quantity: 1, requirements: '直接下单，做好后发给客户货'
      }),
      created({ id: 'link-only', order_no: 'LINK-1', order_date: '2026-11-24', product_name: 'Mat', quantity: 1, size: '1 m', requirements: '' })
    ],
    new Map([
      ['bull', [{ buffer: PNG, extension: 'png', url }]],
      ['link-only', [{ url: linkedOnly }]]
    ])
  );
  const sheet = await readWorkbook(buffer);
  assert.deepEqual(sheet.getRow(1).values.slice(1), [...FACTORY_EXPORT_COLUMNS]);
  const photo = sheet.getRow(2).getCell(3).value;
  assert.equal(photo.text, url);
  assert.equal(photo.hyperlink, url);
  assert.equal(photo.text.includes('\n'), false);
  assert.equal(sheet.getRow(2).getCell(3).alignment.vertical, 'bottom');
  assert.equal(sheet.getRow(2).getCell(3).alignment.wrapText, true);
  assert.equal(sheet.getRow(2).getCell(7).value, '');
  assertImagesSitAboveUrl(sheet, 2);
  assert.equal(sheet.getImages().length, 1);
  const linkOnly = sheet.getRow(3).getCell(3).value;
  assert.equal(linkOnly.text, linkedOnly);
  assert.equal(linkOnly.hyperlink, linkedOnly);
  assert.equal(sheet.getRow(3).getCell(3).alignment?.vertical === 'bottom', false);
  const dumped = JSON.stringify(sheet.getRow(2).values);
  assert.equal(dumped.includes('订单号'), false);
  assert.equal(dumped.includes('BULL-1'), false);
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
  assert.deepEqual(sources.map(source => source.publicUrl), ['https://cdn.shopify.com/a.jpg', 'https://cdn.shopify.com/b.jpg', '']);
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
  assert.match(html, /\/app-v2\.js\?v=20261123-3"/);
});
