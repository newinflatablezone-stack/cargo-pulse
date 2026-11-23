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

// Excel column width is in units of the default font's digit (Calibri 11 ≈ 7px).
function columnWidthPx(width) {
  const maxDigitWidth = 7;
  return Math.floor(((256 * width + Math.floor(128 / maxDigitWidth)) / 256) * maxDigitWidth);
}

const IMAGE_MAX_PX = 112;
const IMAGE_PAD_PX = 6;
const IMAGE_GAP_PX = 8;
const EMU_PER_PX = 9525;
const TEXT_LINE_PT = 18;

function textUnits(text) {
  let units = 0;
  for (const char of String(text)) units += char.charCodeAt(0) > 255 ? 2 : 1;
  return units;
}

function wrappedLineCount(text, columnWidth) {
  const capacity = Math.max(8, Math.floor(Number(columnWidth) * 0.9));
  const source = String(text || '');
  if (!source) return 0;
  return source.split('\n').reduce((sum, line) => {
    return sum + Math.max(1, Math.ceil(Math.max(1, textUnits(line)) / capacity));
  }, 0);
}

function cellText(value) {
  if (!value) return '';
  if (typeof value === 'object') return String(value.text || '');
  return String(value);
}

// One band of photos across the top of 产品图片. Several photos sit side by
// side and shrink to stay inside the column; the URL uses the rows below.
function placeProductImages(count, columnWidth) {
  const columnPx = columnWidthPx(columnWidth);
  const gaps = Math.max(0, count - 1) * IMAGE_GAP_PX;
  const available = Math.max(count, columnPx - IMAGE_PAD_PX * 2 - gaps);
  const size = Math.max(1, Math.min(IMAGE_MAX_PX, Math.floor(available / count)));
  const slots = [];
  for (let index = 0; index < count; index += 1) {
    const leftPx = IMAGE_PAD_PX + index * (size + IMAGE_GAP_PX);
    slots.push({
      size,
      colOff: Math.round(leftPx * EMU_PER_PX),
      rowOff: Math.round(IMAGE_PAD_PX * EMU_PER_PX)
    });
  }
  return {
    slots,
    bottomPt: ((IMAGE_PAD_PX + size) * EMU_PER_PX) / 12700
  };
}

function productImageRowHeight(row, cellValue, placement, columnWidths) {
  const urlLines = wrappedLineCount(cellText(cellValue), columnWidths['产品图片']);
  const picturePt = placement.bottomPt + 10 + urlLines * TEXT_LINE_PT + 8;
  const textColumns = [
    ['产品名称', columnWidths['产品名称']],
    ['尺寸', columnWidths['尺寸']],
    ['下单要求', columnWidths['下单要求']]
  ];
  const textPt = textColumns.reduce((tallest, [name, width]) => {
    return Math.max(tallest, wrappedLineCount(row[name], width) * TEXT_LINE_PT + 8);
  }, 22);
  return Math.min(409, Math.ceil(Math.max(picturePt, textPt)));
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
  const columnWidths = {
    下单日期: 14, 产品名称: 28, 产品图片: 46, 尺寸: 16, 数量: 10, 下单要求: 36, 交货日期: 14
  };
  FACTORY_EXPORT_COLUMNS.forEach((name, index) => { sheet.getColumn(index + 1).width = columnWidths[name]; });
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
    // Pictures float above the cell text. Keep each photo in a top band and
    // bottom-align the https URL so wrap stays in the space under the photo.
    const placement = placeProductImages(embedded.length, columnWidths['产品图片']);
    cell.alignment = { horizontal: 'left', vertical: 'bottom', wrapText: true };
    added.height = productImageRowHeight(line.row, text, placement, columnWidths);
    embedded.forEach((image, index) => {
      const slot = placement.slots[index];
      const imageId = workbook.addImage({ base64: bytesToBase64(image.buffer), extension: image.extension });
      sheet.addImage(imageId, {
        tl: {
          nativeCol: imageColumn - 1,
          nativeColOff: slot.colOff,
          nativeRow: added.number - 1,
          nativeRowOff: slot.rowOff
        },
        ext: { width: slot.size, height: slot.size },
        editAs: 'oneCell'
      });
    });
  }
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: FACTORY_EXPORT_COLUMNS.length } };
  return workbook.xlsx.writeBuffer();
}
