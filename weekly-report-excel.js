// Browser-only workbook for the 周报 page. The data service must not import this
// file: production deploy copies only the existing backend runtime modules.
import { beijingWeekRange, weeklyReportMonthKey, weeklyReportMonthLabel } from './weekly-report.js';

export const WEEKLY_REPORT_EXCEL_EMPTY = '还没有可导出的周报';
const PREFERRED_NAMES = ['Sherry', 'Demi', 'Rayna'];
const METRICS = [
  ['inquiries', '询盘', '0'],
  ['unpaid_orders', '下单未付', '0'],
  ['calls', '电话', '0'],
  ['performance', '业绩', '0.##']
];
const FONT = '微软雅黑';
const GREEN = 'FF174438';
const INK = 'FF183F35';
const MUTED = 'FF5B716B';
const WHITE = 'FFFFFFFF';
const HEADER = 'FFE8F2EE';
const ZEBRA = 'FFF7FBF9';
const TOTAL = 'FFDCE8E3';
const LINE = 'FFD5E0DA';
const THIN = { style: 'thin', color: { argb: LINE } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };

export function weeklyReportWeekShortLabel(weekStart, weekEnd) {
  return `${Number(String(weekStart).slice(8))}-${Number(String(weekEnd).slice(8))}号`;
}

function personName(row) {
  return String(row?.salesperson_name || '').trim() || '业务员';
}

function weekEndOf(row) {
  const end = String(row?.week_end || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(end)) return end;
  return beijingWeekRange(row.week_start).week_end;
}

function savedReports(reports) {
  return (reports || []).filter(row => row?.week_start && /^\d{4}-\d{2}-\d{2}$/.test(String(row.week_start))).map(row => ({
    ...row,
    salesperson_name: personName(row),
    week_end: weekEndOf(row)
  })).filter(row => weeklyReportMonthKey(row.week_end));
}

function sortNames(names) {
  return [...names].sort((a, b) => {
    const left = PREFERRED_NAMES.indexOf(a);
    const right = PREFERRED_NAMES.indexOf(b);
    if (left !== -1 || right !== -1) return (left === -1 ? 99 : left) - (right === -1 ? 99 : right);
    return a.localeCompare(b, 'zh-CN');
  });
}

function monthGroups(reports) {
  const groups = new Map();
  for (const row of savedReports(reports)) {
    const month = weeklyReportMonthKey(row.week_end);
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(row);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, rows]) => {
    const weeks = [...new Map(rows.map(row => [row.week_start, { week_start: row.week_start, week_end: row.week_end }])).values()]
      .sort((a, b) => a.week_start.localeCompare(b.week_start));
    const names = sortNames([...new Set(rows.map(row => row.salesperson_name))]);
    return { month, label: weeklyReportMonthLabel(month), rows, weeks, names };
  });
}

export function weeklyReportExcelFilename(reports) {
  const months = monthGroups(reports);
  if (!months.length) return '周报.xlsx';
  if (months.length === 1) return `周报-${months[0].label}.xlsx`;
  return `周报-${months[0].label}-${months.at(-1).label}.xlsx`;
}

export function weeklyReportExcelTotalTitle(names) {
  const present = new Set(names);
  return PREFERRED_NAMES.length === names.length && PREFERRED_NAMES.every(name => present.has(name)) ? '三人合计' : '合计';
}

function noteText(value) {
  const text = String(value ?? '').trim();
  return text || '—';
}

function numericValue(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function findRow(rows, name, weekStart) {
  return rows.find(row => row.salesperson_name === name && row.week_start === weekStart) || null;
}

function paint(cell, { value = null, size = 10, bold = false, color = INK, fill = WHITE, horizontal = 'center', vertical = 'middle', wrap = true, format = '', border = true } = {}) {
  if (value != null && value !== '') cell.value = value;
  cell.font = { name: FONT, size, bold, color: { argb: color } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  cell.alignment = { horizontal, vertical, wrapText: wrap };
  cell.border = border ? BORDER : {};
  if (format) cell.numFmt = format;
}

function writeMerged(sheet, row, from, to, value, style) {
  sheet.mergeCells(row, from, row, to);
  paint(sheet.getRow(row).getCell(from), { ...style, value });
  for (let column = from + 1; column <= to; column += 1) paint(sheet.getRow(row).getCell(column), { ...style, value: null });
}

function columnName(index) {
  let n = index;
  let name = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function pageSetup(sheet) {
  sheet.pageSetup = {
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 1,
    paperSize: 9,
    printTitlesRow: '1:2'
  };
  sheet.views = [{ state: 'frozen', ySplit: 3, showGridLines: false, zoomScale: 100 }];
  sheet.pageSetup.horizontalCentered = false;
}

function writeTitle(sheet, lastColumn, label) {
  sheet.getRow(1).height = 28;
  sheet.getRow(2).height = 20;
  writeMerged(sheet, 1, 1, lastColumn, '周报', { size: 18, bold: true, color: GREEN, fill: WHITE, horizontal: 'left', wrap: false, border: false });
  writeMerged(sheet, 2, 1, lastColumn, `${label}    周期为周四至周三（北京时间）`, { size: 11, bold: false, color: MUTED, fill: WHITE, horizontal: 'left', wrap: false, border: false });
}

function buildSummarySheet(workbook, group) {
  const sheet = workbook.addWorksheet(group.label);
  const lastColumn = group.weeks.length + 2;
  sheet.getColumn(1).width = 12;
  for (let index = 0; index < group.weeks.length; index += 1) sheet.getColumn(index + 2).width = 28;
  sheet.getColumn(lastColumn).width = 14;
  writeTitle(sheet, lastColumn, group.label);
  const metricRows = [];
  let row = 4;
  for (const name of group.names) {
    sheet.getRow(row).height = 22;
    writeMerged(sheet, row, 1, lastColumn, name, { size: 13, bold: true, color: WHITE, fill: GREEN, horizontal: 'left', wrap: false });
    const short = sheet.getRow(row + 1);
    const dates = sheet.getRow(row + 2);
    short.height = 20;
    dates.height = 18;
    paint(short.getCell(1), { value: '项目', size: 10, bold: true, color: GREEN, fill: HEADER });
    paint(dates.getCell(1), { fill: HEADER });
    paint(short.getCell(lastColumn), { value: '合计', size: 10, bold: true, color: GREEN, fill: HEADER });
    paint(dates.getCell(lastColumn), { fill: HEADER });
    group.weeks.forEach((week, index) => {
      const column = index + 2;
      paint(short.getCell(column), { value: weeklyReportWeekShortLabel(week.week_start, week.week_end), size: 10, bold: true, color: GREEN, fill: HEADER });
      paint(dates.getCell(column), { value: `${week.week_start} 至 ${week.week_end}`, size: 8, color: MUTED, fill: HEADER });
    });
    const recorded = {};
    METRICS.forEach(([key, label, format], index) => {
      const metricRow = sheet.getRow(row + 3 + index);
      metricRow.height = 22;
      const fill = index % 2 === 0 ? ZEBRA : WHITE;
      paint(metricRow.getCell(1), { value: label, size: 10, bold: true, color: INK, fill, horizontal: 'left' });
      group.weeks.forEach((week, weekIndex) => {
        const value = numericValue(findRow(group.rows, name, week.week_start)?.[key]);
        paint(metricRow.getCell(weekIndex + 2), { value, size: 10, color: INK, fill, format, bold: false });
      });
      const first = columnName(2);
      const last = columnName(lastColumn - 1);
      const address = `${first}${metricRow.number}:${last}${metricRow.number}`;
      paint(metricRow.getCell(lastColumn), { value: { formula: `SUM(${address})` }, size: 10, bold: true, color: GREEN, fill: TOTAL, format });
      recorded[key] = metricRow.number;
    });
    const noteRow = sheet.getRow(row + 7);
    noteRow.height = 52;
    paint(noteRow.getCell(1), { value: '备注', size: 10, bold: true, color: INK, fill: WHITE, horizontal: 'left', vertical: 'top' });
    group.weeks.forEach((week, index) => {
      paint(noteRow.getCell(index + 2), { value: noteText(findRow(group.rows, name, week.week_start)?.note), size: 9, color: MUTED, fill: WHITE, horizontal: 'left', vertical: 'top' });
    });
    paint(noteRow.getCell(lastColumn), { fill: TOTAL });
    metricRows.push(recorded);
    row += 9;
  }
  sheet.getRow(row).height = 22;
  writeMerged(sheet, row, 1, lastColumn, weeklyReportExcelTotalTitle(group.names), { size: 13, bold: true, color: WHITE, fill: GREEN, horizontal: 'left', wrap: false });
  const short = sheet.getRow(row + 1);
  const dates = sheet.getRow(row + 2);
  short.height = 20;
  dates.height = 18;
  paint(short.getCell(1), { value: '项目', size: 10, bold: true, color: GREEN, fill: HEADER });
  paint(dates.getCell(1), { fill: HEADER });
  paint(short.getCell(lastColumn), { value: '合计', size: 10, bold: true, color: GREEN, fill: HEADER });
  paint(dates.getCell(lastColumn), { fill: HEADER });
  group.weeks.forEach((week, index) => {
    const column = index + 2;
    paint(short.getCell(column), { value: weeklyReportWeekShortLabel(week.week_start, week.week_end), size: 10, bold: true, color: GREEN, fill: HEADER });
    paint(dates.getCell(column), { value: `${week.week_start} 至 ${week.week_end}`, size: 8, color: MUTED, fill: HEADER });
  });
  METRICS.forEach(([key, label, format], index) => {
    const metricRow = sheet.getRow(row + 3 + index);
    metricRow.height = 22;
    paint(metricRow.getCell(1), { value: label, size: 10, bold: true, color: INK, fill: TOTAL, horizontal: 'left' });
    for (let column = 2; column <= lastColumn; column += 1) {
      const refs = metricRows.map(item => `${columnName(column)}${item[key]}`).join(',');
      paint(metricRow.getCell(column), { value: { formula: `SUM(${refs})` }, size: 10, bold: true, color: GREEN, fill: TOTAL, format });
    }
  });
  pageSetup(sheet);
  return sheet;
}

function buildPersonSheet(workbook, group, singleMonth) {
  const sheet = workbook.addWorksheet(singleMonth ? '按人分列（附件排版）' : `${group.label}-按人`);
  sheet.getColumn(1).width = 14;
  sheet.getColumn(2).width = 18;
  sheet.getColumn(3).width = 56;
  writeTitle(sheet, 3, group.label);
  let row = 4;
  group.names.forEach((name, personIndex) => {
    const weeks = group.weeks.filter(week => findRow(group.rows, name, week.week_start));
    sheet.getRow(row).height = 22;
    writeMerged(sheet, row, 1, 3, name, { size: 13, bold: true, color: WHITE, fill: GREEN, horizontal: 'left', wrap: false });
    row += 1;
    const metricRows = Object.fromEntries(METRICS.map(([key]) => [key, []]));
    for (const week of weeks) {
      const record = findRow(group.rows, name, week.week_start);
      sheet.getRow(row).height = 20;
      writeMerged(sheet, row, 1, 3, `${weeklyReportWeekShortLabel(week.week_start, week.week_end)}    ${week.week_start} 至 ${week.week_end}`, { size: 10, bold: true, color: GREEN, fill: HEADER, horizontal: 'left', wrap: false });
      row += 1;
      METRICS.forEach(([key, label, format], index) => {
        const metricRow = sheet.getRow(row);
        metricRow.height = 20;
        const fill = index % 2 === 0 ? ZEBRA : WHITE;
        paint(metricRow.getCell(1), { value: label, size: 10, bold: true, color: INK, fill, horizontal: 'left' });
        paint(metricRow.getCell(2), { value: numericValue(record?.[key]), size: 10, color: INK, fill, format, bold: false });
        paint(metricRow.getCell(3), { fill });
        metricRows[key].push(row);
        row += 1;
      });
      const note = noteText(record?.note);
      const noteRow = sheet.getRow(row);
      noteRow.height = note === '—' ? 20 : 36;
      paint(noteRow.getCell(1), { value: '备注', size: 10, bold: true, color: INK, fill: WHITE, horizontal: 'left', vertical: 'top' });
      sheet.mergeCells(row, 2, row, 3);
      paint(noteRow.getCell(2), { value: note, size: 9, color: MUTED, fill: WHITE, horizontal: 'left', vertical: 'top' });
      paint(noteRow.getCell(3), { value: null, size: 9, color: MUTED, fill: WHITE, horizontal: 'left', vertical: 'top' });
      row += 1;
    }
    sheet.getRow(row).height = 20;
    writeMerged(sheet, row, 1, 3, '合计', { size: 10, bold: true, color: GREEN, fill: TOTAL, horizontal: 'left', wrap: false });
    row += 1;
    METRICS.forEach(([key, label, format]) => {
      const metricRow = sheet.getRow(row);
      metricRow.height = 20;
      const refs = metricRows[key].map(number => `B${number}`).join(',');
      paint(metricRow.getCell(1), { value: label, size: 10, bold: true, color: INK, fill: TOTAL, horizontal: 'left' });
      paint(metricRow.getCell(2), { value: refs ? { formula: `SUM(${refs})` } : null, size: 10, bold: true, color: GREEN, fill: TOTAL, format });
      paint(metricRow.getCell(3), { fill: TOTAL });
      row += 1;
    });
    if (personIndex < group.names.length - 1) row += 2;
  });
  pageSetup(sheet);
  return sheet;
}

export async function buildWeeklyReportWorkbook(reports) {
  const months = monthGroups(reports);
  if (!months.length) throw Error(WEEKLY_REPORT_EXCEL_EMPTY);
  const excelModule = await import('exceljs');
  const ExcelJS = excelModule.default || excelModule;
  const workbook = new ExcelJS.Workbook();
  workbook.calcProperties.fullCalcOnLoad = true;
  for (const group of months) {
    buildSummarySheet(workbook, group);
    buildPersonSheet(workbook, group, months.length === 1);
  }
  return workbook.xlsx.writeBuffer();
}
