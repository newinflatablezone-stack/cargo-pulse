// Factory 下单文件 for merchandisers. Orders persist one product
// (product_name, size, quantity, requirements). Shopify line items are
// summarized into those fields at import — names joined with " / ",
// quantities summed, sizes joined — and are not stored as separate lines.
// Exporting therefore writes one row per order. Splitting the joined name
// would invent per-item quantities and sizes the order does not have.

export const FACTORY_EXPORT_COLUMNS = Object.freeze([
  '下单日期', '产品名称', '产品图片', '尺寸', '数量', '下单要求', '交货日期'
]);

export const FACTORY_EXPORT_EXCLUDED_STEPS = Object.freeze([
  'sales_supplement', 'follower_create', 'salesperson_draft'
]);

export const FACTORY_EXPORT_EMPTY_MESSAGE = '请先勾选要导出的订单';
export const FACTORY_EXPORT_IMAGE_LIMIT = 6;
export const FACTORY_EXPORT_SHEET = '工厂下单';

const EXCLUDED = new Set(FACTORY_EXPORT_EXCLUDED_STEPS);

export function canUseFactoryExport(profile) {
  return profile?.role === 'follower';
}

export function isFactoryExportable(order) {
  if (!order || typeof order !== 'object' || order.deleted_at) return false;
  const step = String(order.current_step || '');
  return Boolean(step) && !EXCLUDED.has(step);
}

export function beijingCalendarDate(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(value);
}

export function factoryExportFilename(value = new Date()) {
  return `工厂下单文件-${beijingCalendarDate(value)}.xlsx`;
}

// Official 下单日期 is the stored order_date string. Do not reformat it
// through Date, which can shift the Beijing calendar day.
export function officialOrderDate(order) {
  const value = String(order?.order_date ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}

function exportQuantity(value) {
  if (value == null || value === '') return '';
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : String(value).trim();
}

export function factoryExportRows(order) {
  if (!isFactoryExportable(order)) return [];
  return [{
    下单日期: officialOrderDate(order),
    产品名称: String(order.product_name ?? '').trim(),
    尺寸: String(order.size ?? '').trim(),
    数量: exportQuantity(order.quantity),
    下单要求: String(order.requirements ?? '').trim(),
    交货日期: ''
  }];
}

export function factoryImageExtension(bytes, contentType = '') {
  const type = String(contentType || '').toLowerCase();
  if (type.startsWith('text/') || type.includes('json') || type.includes('html')) return '';
  const head = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return 'gif';
  return '';
}

function httpsUrl(value) {
  const url = String(value || '').trim();
  if (!url.startsWith('https://')) return '';
  try {
    return new URL(url).protocol === 'https:' ? url : '';
  } catch {
    return '';
  }
}

// Product photos already on the order: Shopify https URLs, plus uploaded
// files whose path contains /product-image-. Delivery proofs are not included.
// publicUrl is set only for Shopify CDN links a factory can open. Signed
// upload URLs stay empty because they require the merchandiser session.
export function factoryImageSources(order, uploads = []) {
  const sources = [];
  const seen = new Set();
  const shopify = Array.isArray(order?.shopify_image_urls) ? order.shopify_image_urls : [];
  const legacy = Array.isArray(order?.image_urls) ? order.image_urls : [];
  for (const raw of [...shopify, ...legacy]) {
    const url = httpsUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({ fetchUrl: url, publicUrl: url });
  }
  for (const row of uploads || []) {
    const path = String(row?.object_path || '');
    if (!path.includes('/product-image-') || seen.has(path)) continue;
    const fetchUrl = httpsUrl(row?.url) || String(row?.url || '').trim();
    if (!fetchUrl) continue;
    seen.add(path);
    sources.push({ fetchUrl, publicUrl: '' });
  }
  return sources;
}

function bytesToBase64(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function imageExtensionName(value) {
  const extension = String(value || '').toLowerCase();
  if (extension === 'jpg' || extension === 'jpeg') return 'jpeg';
  if (extension === 'png' || extension === 'gif') return extension;
  return '';
}

function imageCellValue(images) {
  const links = [];
  const notes = [];
  for (const image of images || []) {
    const url = httpsUrl(image?.url);
    if (url) links.push(url);
    else if (image?.text) notes.push(String(image.text));
  }
  if (links.length === 1 && !notes.length) return { text: links[0], hyperlink: links[0] };
  return [...links, ...notes].join('\n');
}

function imagesFor(order, imagesByOrderId) {
  if (!imagesByOrderId) return [];
  if (imagesByOrderId instanceof Map) {
    return imagesByOrderId.get(order.id) || imagesByOrderId.get(String(order.id)) || [];
  }
  return imagesByOrderId[order.id] || imagesByOrderId[String(order.id)] || [];
}

export async function buildFactoryOrderWorkbook(orders, imagesByOrderId = new Map()) {
  const lines = [];
  for (const order of orders || []) {
    const rows = factoryExportRows(order);
    if (!rows.length) continue;
    const images = imagesFor(order, imagesByOrderId);
    for (const row of rows) lines.push({ row, images, sortDate: row['下单日期'], sortNo: String(order.order_no ?? '') });
  }
  lines.sort((a, b) => a.sortDate.localeCompare(b.sortDate) || a.sortNo.localeCompare(b.sortNo, 'zh-CN'));
  if (!lines.length) throw Object.assign(new Error(FACTORY_EXPORT_EMPTY_MESSAGE), { code: 'empty-factory-export' });

  const excelModule = await import('exceljs');
  const ExcelJS = excelModule.default || excelModule;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(FACTORY_EXPORT_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
  const header = sheet.addRow([...FACTORY_EXPORT_COLUMNS]);
  header.font = { name: 'Microsoft YaHei', bold: true, size: 11, color: { argb: 'FF174438' } };
  header.alignment = { vertical: 'middle' };
  header.height = 22;
  const imageColumn = FACTORY_EXPORT_COLUMNS.indexOf('产品图片') + 1;
  [14, 28, 18, 16, 10, 36, 14].forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  for (const name of ['产品名称', '产品图片', '下单要求']) sheet.getColumn(FACTORY_EXPORT_COLUMNS.indexOf(name) + 1).alignment = { wrapText: true, vertical: 'top' };

  for (const line of lines) {
    const values = FACTORY_EXPORT_COLUMNS.map(column => line.row[column] ?? '');
    const added = sheet.addRow(values);
    added.font = { name: 'Microsoft YaHei', size: 11 };
    added.alignment = { vertical: 'top', wrapText: true };
    const cell = added.getCell(imageColumn);
    const text = imageCellValue(line.images);
    cell.value = text || '';
    if (text && typeof text === 'object') cell.font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF174438' }, underline: true };
    const embedded = [];
    for (const image of line.images || []) {
      const extension = imageExtensionName(image?.extension);
      if (!extension || image.buffer == null || embedded.length >= FACTORY_EXPORT_IMAGE_LIMIT) continue;
      embedded.push({ buffer: image.buffer, extension });
    }
    if (!embedded.length) continue;
    added.height = Math.max(22, embedded.length * 78);
    embedded.forEach((image, index) => {
      const imageId = workbook.addImage({ base64: bytesToBase64(image.buffer), extension: image.extension });
      const slot = 1 / embedded.length;
      sheet.addImage(imageId, {
        tl: { col: imageColumn - 1 + 0.08, row: (added.number - 1) + index * slot + 0.06 },
        ext: { width: 72, height: 72 },
        editAs: 'oneCell'
      });
    });
  }
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: FACTORY_EXPORT_COLUMNS.length } };
  return workbook.xlsx.writeBuffer();
}
