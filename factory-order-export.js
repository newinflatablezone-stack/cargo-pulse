export const FACTORY_EXPORT_COLUMNS = Object.freeze([
  '下单日期', '产品名称', '产品图片', '尺寸', '数量', '下单要求', '交货日期', '图片URL'
]);

export const FACTORY_EXPORT_EXCLUDED_STEPS = Object.freeze([
  'sales_supplement', 'follower_create', 'salesperson_draft'
]);

export const FACTORY_EXPORT_EMPTY_MESSAGE = '请先勾选要导出的订单';
export const FACTORY_EXPORT_IMAGE_LIMIT = 6;
export const FACTORY_EXPORT_SHEET = '工厂下单';
export const FACTORY_IMAGE_SHEET = '图片明细';

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

// Keep one entry per saved product photo and omit delivery-proof attachments.
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
    const fetchUrl = httpsUrl(row?.url);
    if (!fetchUrl) continue;
    seen.add(path);
    sources.push({ fetchUrl, publicUrl: fetchUrl });
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

const PREVIEWS_PER_ROW = 3;
const PREVIEW_LIMIT = 12;
const EMBED_PADDING = 6;
const EMBED_GAP = 8;
const PX_PER_EXCEL_WIDTH = 7;
const PX_TO_PT = .75;
const EMU_PER_PX = 9525;

function lineHeight(value, width) {
  const text = typeof value === 'object' ? value?.text : value;
  const capacity = Math.max(8, Math.floor(width * .88));
  const lines = String(text ?? '').split('\n').reduce((total, line) => {
    const units = [...line].reduce((count, char) => count + (char.charCodeAt(0) > 255 ? 2 : 1), 0);
    return total + Math.max(1, Math.ceil(units / capacity));
  }, 0);
  return lines * 17 + 10;
}

function addPhoto(sheet, row, column, image, x, y, limit) {
  const width = image.width > 0 ? image.width : limit;
  const height = image.height > 0 ? image.height : limit;
  const scale = Math.min(limit / width, limit / height);
  sheet.addImage(image.mediaId, {
    tl: { nativeCol: column - 1, nativeColOff: Math.round((x + (limit - width * scale) / 2) * EMU_PER_PX),
      nativeRow: row.number - 1, nativeRowOff: Math.round((y + (limit - height * scale) / 2) * EMU_PER_PX) },
    ext: { width: width * scale, height: height * scale }, editAs: 'oneCell'
  });
}

function setHeader(sheet, labels, widths) {
  const header = sheet.addRow(labels);
  header.font = { name: 'Microsoft YaHei', bold: true, size: 11, color: { argb: 'FF174438' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF2EE' } };
  header.alignment = { vertical: 'middle', wrapText: true };
  header.height = 24;
  widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: labels.length } };
}

function formatRow(row) {
  row.font = { name: 'Microsoft YaHei', size: 11 };
  row.alignment = { vertical: 'top', wrapText: true };
}

function imageLink(url) {
  return url ? { text: url, hyperlink: url } : '';
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
  const views = [{ state: 'frozen', ySplit: 1 }];
  const sheet = workbook.addWorksheet(FACTORY_EXPORT_SHEET, { views });
  const detail = workbook.addWorksheet(FACTORY_IMAGE_SHEET, { views });
  const columnWidths = [14, 28, 46, 16, 10, 36, 14, 48];
  const detailWidths = [16, 28, 10, 20, 70, 23];
  setHeader(sheet, [...FACTORY_EXPORT_COLUMNS], columnWidths);
  setHeader(detail, ['下单表行号', '产品名称', '图片序号', '产品图片', '图片URL', '说明'], detailWidths);
  const media = new Map();
  const photos = images => images.map(image => {
    const extension = imageExtensionName(image?.extension);
    if (!extension || image?.buffer == null) return image;
    if (!media.has(image.buffer)) {
      media.set(image.buffer, workbook.addImage({ base64: bytesToBase64(image.buffer), extension }));
    }
    return { ...image, mediaId: media.get(image.buffer) };
  });

  for (const line of lines) {
    const row = sheet.addRow(FACTORY_EXPORT_COLUMNS.map(column => line.row[column] ?? ''));
    formatRow(row);
    const images = photos(line.images);
    const firstDetail = detail.rowCount + 1;
    images.forEach((image, index) => {
      const url = httpsUrl(image?.url);
      const photoRow = detail.addRow([row.number, line.row['产品名称'], index + 1, '', imageLink(url), image?.text || '']);
      formatRow(photoRow);
      const previewSize = 104;
      if (image?.mediaId != null) addPhoto(detail, photoRow, 4, image, EMBED_PADDING, EMBED_PADDING, previewSize);
      photoRow.height = Math.min(409, Math.ceil(Math.max(
        lineHeight(line.row['产品名称'], detailWidths[1]), lineHeight(url, detailWidths[4]),
        lineHeight(image?.text, detailWidths[5]), image?.mediaId == null ? 24 : (previewSize + EMBED_PADDING * 2) * PX_TO_PT
      )));
    });
    if (images.length === 1) row.getCell(8).value = imageLink(httpsUrl(images[0]?.url));
    if (images.length > 1) row.getCell(8).value = '见「图片明细」第 ' + firstDetail + '–' + detail.rowCount + ' 行（' + images.length + ' 张）';

    const embedded = images.filter(image => image?.mediaId != null);
    const previews = embedded.slice(0, PREVIEW_LIMIT);
    const size = Math.floor((columnWidths[2] * PX_PER_EXCEL_WIDTH - EMBED_PADDING * 2 - EMBED_GAP * (PREVIEWS_PER_ROW - 1)) / PREVIEWS_PER_ROW);
    const bands = Math.ceil(previews.length / PREVIEWS_PER_ROW);
    previews.forEach((image, index) => addPhoto(sheet, row, 3, image,
      EMBED_PADDING + (index % PREVIEWS_PER_ROW) * (size + EMBED_GAP),
      EMBED_PADDING + Math.floor(index / PREVIEWS_PER_ROW) * (size + EMBED_GAP), size));
    if (embedded.length > previews.length) row.getCell(3).value = '其余图片见「图片明细」';
    if (!previews.length && images.length) row.getCell(3).value = images.length === 1 && images[0]?.text ? images[0].text : '图片见「图片明细」';
    const previewHeight = bands ? (bands * size + (bands - 1) * EMBED_GAP + EMBED_PADDING * 2) * PX_TO_PT : 0;
    const imageNoteHeight = embedded.length > previews.length ? lineHeight(row.getCell(3).value, columnWidths[2]) : 0;
    if (imageNoteHeight) row.getCell(3).alignment = { vertical: 'bottom', wrapText: true };
    row.height = Math.min(409, Math.ceil(Math.max(
      previewHeight + imageNoteHeight,
      ...columnWidths.map((width, index) => lineHeight(row.getCell(index + 1).value, width))
    )));
  }
  return workbook.xlsx.writeBuffer();
}
