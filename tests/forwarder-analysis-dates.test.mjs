import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {singaporeToday,makeForwarderDateRange,orderWithinForwarderRange} from '../forwarder-analysis-dates.mjs';

test('preset periods use Singapore calendar dates and cross years correctly',()=>{
  assert.equal(singaporeToday(new Date('2026-10-18T17:00:00Z')),'2026-10-19');
  for(const [period,start] of [['1','2026-09-19'],['3','2026-07-19'],['6','2026-04-19'],['12','2025-10-19']])assert.deepEqual(makeForwarderDateRange(period,'','','2026-10-19'),{period,start,end:'2026-10-19'});
});
test('calendar month subtraction clamps month ends and leap years',()=>{
  assert.equal(makeForwarderDateRange('1','','','2026-03-31').start,'2026-02-28');
  assert.equal(makeForwarderDateRange('1','','','2024-03-31').start,'2024-02-29');
  assert.equal(makeForwarderDateRange('12','','','2024-02-29').start,'2023-02-28');
});
test('custom range includes both endpoints and rejects missing, invalid or reversed dates',()=>{
  const range=makeForwarderDateRange('custom','2026-10-01','2026-10-19','2026-10-19');
  for(const order_date of ['2026-10-01','2026-10-19','2026-10-19T23:59:59'])assert.equal(orderWithinForwarderRange({order_date},range),true);
  for(const order_date of ['2026-09-30','2026-10-20','2026-02-30','',null])assert.equal(orderWithinForwarderRange({order_date},range),false);
  assert.equal(orderWithinForwarderRange({order_date:'2026-10-10',deleted_at:'2026-10-11'},range),false);
  assert.throws(()=>makeForwarderDateRange('custom','','2026-10-19','2026-10-19'));
  assert.throws(()=>makeForwarderDateRange('custom','2026-10-19','2026-10-01','2026-10-19'));
  assert.throws(()=>makeForwarderDateRange('custom','2026-02-30','2026-10-01','2026-10-19'));
  assert.throws(()=>makeForwarderDateRange('custom','2026-10-01','2026-10-20','2026-10-19'));
});
test('changing range updates volume, share and abnormal rate, including split shipment deduplication',()=>{
  const source=readFileSync(new URL('../app-v2.js',import.meta.url),'utf8');
  const fn=source.split('\n').find(line=>line.startsWith('function forwarderAnalysisRows('));
  const ctx={orders:[{id:'old',order_date:'2026-05-01',forwarder_name:'A'},{id:'first',order_date:'2026-10-01',forwarder_name:'A',red_delay_cause:'forwarder'},{id:'last',order_date:'2026-10-19',forwarder_name:'B'},{id:'future',order_date:'2026-10-20',forwarder_name:'A'},{id:'deleted',order_date:'2026-10-19',forwarder_name:'A',deleted_at:'today'}],normalizeForwarderName:value=>value||'',orderWithinForwarderRange,shipmentRowsForOrder:order=>order.id==='last'?[{forwarder_name:'B'},{forwarder_name:'B'}]:[]};
  runInNewContext(fn,ctx);
  const meta={forwarderScores:[{name:'A',reliability:90,channel:80},{name:'B',reliability:80,channel:90}],forwarderIssueOrderIds:['old']};
  const short=ctx.forwarderAnalysisRows(meta,makeForwarderDateRange('1','','','2026-10-19'));
  assert.equal(short[0].total,1);assert.equal(short[0].abnormal,1);assert.equal(short[0].rate,100);assert.equal(short[0].share,50);assert.equal(short[1].total,1);
  const long=ctx.forwarderAnalysisRows(meta,makeForwarderDateRange('6','','','2026-10-19'));
  assert.equal(long[0].total,2);assert.equal(long[0].abnormal,2);assert.equal(long[1].total,1);assert.ok(Math.abs(long[0].share-200/3)<1e-10);
  assert.equal(ctx.forwarderAnalysisRows(meta,makeForwarderDateRange('custom','2026-10-19','2026-10-19','2026-10-19'))[0].total,0);
});
