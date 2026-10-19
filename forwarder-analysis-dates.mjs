export function singaporeToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const value = type => parts.find(part => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function validAnalysisDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value+'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === value;
}

export function makeForwarderDateRange(period = '3', start = '', end = '', today = singaporeToday()) {
  if (!validAnalysisDate(today)) throw Error('当前日期无效');
  if (period === 'custom') {
    if (!validAnalysisDate(start) || !validAnalysisDate(end)) throw Error('请选择有效的开始和结束日期');
    if (start > end) throw Error('开始日期不能晚于结束日期');
    if (end > today) throw Error('结束日期不能晚于今天');
    return {period,start,end};
  }
  if (!['1','3','6','12'].includes(String(period))) throw Error('请选择有效的统计周期');
  const date = new Date(today+'T00:00:00Z'), day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth()-Number(period));
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();
  date.setUTCDate(Math.min(day,lastDay));
  return {period:String(period),start:date.toISOString().slice(0,10),end:today};
}

export function orderWithinForwarderRange(order, range) {
  if (order.deleted_at) return false;
  const date = String(order.order_date || '').slice(0,10);
  return validAnalysisDate(date) && date >= range.start && date <= range.end;
}
