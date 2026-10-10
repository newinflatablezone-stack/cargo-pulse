import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TencentDataStore } from '../server/tencent-data-core.mjs';
import { runInNewContext } from 'node:vm';
import { eventsWithinCurrentFlow, currentStageNumber, resetNumberStageNote, trackingFieldsOnEntry, flowFor } from '../workflow.js';

const source=readFileSync(new URL('../app-v2.js',import.meta.url),'utf8');
const getFunction=name=>source.split('\n').find(line=>line.startsWith('function '+name+'(')||line.startsWith('async function '+name+'('));
const sea={id:'8873',shipping_mode:'domestic_sea',current_step:'domestic_customs',step_started_at:'2026-09-23T00:00:00Z'};
const future={id:'future',order_id:'8873',step_key:'ocean_tracking',note:'tracking:Fedex 876413054978',started_at:'2026-09-29T00:00:00Z',completed_at:'2026-09-29T00:00:00Z'};
const active={id:'active',order_id:'8873',step_key:'domestic_customs',started_at:sea.step_started_at,completed_at:null};

test('未开船订单隔离未来海运节点，列表单号和详情时间线都不显示它',async()=>{
 const history=[{order_id:sea.id,step_key:'production',completed_at:'2026-09-23T00:00:00Z'},active,future];
 assert.deepEqual(eventsWithinCurrentFlow(sea,history).map(row=>row.step_key),['production','domestic_customs']);
 const box={innerHTML:'',querySelector(){return null;}};
 const ctx={eventsWithinCurrentFlow,currentStageNumber,flowFor,orders:[sea],eventsByOrderId:new Map([[sea.id,history]]),activeEventsByOrderId:new Map([[sea.id,[active]]]),TRACKING_NOTE_PREFIX:'tracking:',STEP_LABELS:{production:'生产',domestic_customs:'国内清关开船',ocean_tracking:'填写海运单号'},$:(id)=>id==='#orderTimeline'?box:null,api:async()=>history,proofRecord:()=>null,proofApplies:()=>false,esc:value=>String(value),profile:{role:'business'}};
 runInNewContext(['trackingNumberFromNote','trackingEntries','trackingForStep','loadOrderTimeline'].map(getFunction).join('\n'),ctx);
 assert.equal(ctx.trackingEntries(sea).length,0);
 assert.equal(ctx.trackingForStep(sea,'ocean_transit'),'');
 await ctx.loadOrderTimeline(sea.id);
 assert.ok(box.innerHTML.includes('异常记录已隔离'));
 assert.ok(!box.innerHTML.includes('Fedex'));
 assert.ok(!box.innerHTML.includes('填写海运单号'));
 assert.ok(box.innerHTML.includes('国内清关开船'));
});

for(const [step,waiting] of [['ocean_transit','ocean_tracking'],['last_mile','last_mile_tracking']]) {
 test(`${step} 不采用旧历史、其他订单或过期节点的单号`,()=>{
  const order={...sea,current_step:step,step_started_at:'2026-10-10T00:00:00Z'};
  const old={...future,step_key:step,completed_at:'2026-09-29T00:00:00Z'};
  const event={...active,step_key:step,started_at:order.step_started_at,note:null};
  assert.equal(currentStageNumber(order,step,[old,event]),'');
  assert.equal(currentStageNumber(order,step,[{...event,started_at:'2026-09-01',note:'tracking:OLD'}]),'');
  assert.equal(currentStageNumber(order,step,[{...event,order_id:'other',note:'tracking:OTHER'}]),'');
  assert.equal(currentStageNumber(order,step,[{...event,note:'tracking:NEW [rollback-count:1]'}]),'NEW');
  assert.equal(currentStageNumber(order,step,[{...event,note:'tracking:NEW'},event]),'');
  assert.equal(currentStageNumber({...order,current_step:waiting},step,[{...event,note:'tracking:OLD'}]),'');
 });
}

test('分批运输未开船和待填写阶段不采用旧单号，进入新阶段清理遗留字段',()=>{
 const ctx={flowFor,eventsWithinCurrentFlow,currentStageNumber,activeEventsByOrderId:new Map()};
 runInNewContext(['stableStepKey','shipmentCurrentNumber','trackingForStep','displayStepKey'].map(getFunction).join('\n'),ctx);
 const batch={...sea,ocean_tracking_no:'OLD-SEA',last_mile_tracking_no:'OLD-TRUCK'};
 assert.equal(ctx.shipmentCurrentNumber(batch,'ocean_transit'),'');
 assert.equal(ctx.shipmentCurrentNumber(batch,'last_mile'),'');
 assert.equal(ctx.displayStepKey({...batch,current_step:'ocean_tracking'}),'ocean_tracking');
 assert.equal(ctx.displayStepKey({...batch,current_step:'last_mile_tracking'}),'last_mile_tracking');
 assert.deepEqual(trackingFieldsOnEntry('ocean_transit'),{ocean_tracking_no:null,last_mile_tracking_no:null});
 assert.deepEqual(trackingFieldsOnEntry('last_mile'),{last_mile_tracking_no:null});
 assert.equal(ctx.displayStepKey({...batch,...trackingFieldsOnEntry('ocean_transit'),current_step:'ocean_transit'}),'ocean_tracking');
});

test('不同物流路线隔离错误海运记录，正常已发生的历史节点保留',()=>{
 assert.equal(eventsWithinCurrentFlow({...sea,shipping_mode:'domestic_express',current_step:'delivery'},[future]).length,0);
 assert.equal(eventsWithinCurrentFlow({...sea,current_step:'overseas_customs'},[future]).length,1);
 assert.equal(resetNumberStageNote('tracking:OLD [rollback-count:1]','ocean_transit'),'[rollback-count:1]');
 assert.equal(resetNumberStageNote('tracking:OLD','last_mile'),null);
 assert.equal(resetNumberStageNote('private note','domestic_customs'),'private note');
});

test('推进后也不会让旧异常海运记录重新出现',()=>{
 const customs={...active,completed_at:'2026-10-10T00:00:00Z'};
 const ocean={order_id:sea.id,step_key:'ocean_transit',started_at:'2026-10-10T00:00:00Z',completed_at:null,note:'tracking:REAL-OCEAN'};
 const order={...sea,current_step:'ocean_transit',step_started_at:ocean.started_at};
 assert.deepEqual(eventsWithinCurrentFlow(order,[customs,future,ocean]).map(row=>row.step_key),['domestic_customs','ocean_transit']);
 assert.equal(currentStageNumber(order,'ocean_transit',[ocean]),'REAL-OCEAN');
 const arrived={...order,current_step:'overseas_customs',step_started_at:'2026-10-26T00:00:00Z'};
 assert.ok(!eventsWithinCurrentFlow(arrived,[customs,future,{...ocean,completed_at:'2026-10-26T00:00:00Z'}]).includes(future));
});

test('打开和刷新页面不再自动把待填写单号阶段推进到运输阶段',()=>{
 assert.ok(!source.includes('migrateNumberStageAliases'));
});

test('实际回退流程撤销上一轮运输单号，不会自动恢复为正在运输',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cargo-rollback-'));
 const store=new TencentDataStore(join(dir,'data.sqlite'));
 try {
  const user=store.upsertAccount({email:'follower@example.com',password:'password123',role:'follower'});
  const order={...sea,current_step:'overseas_customs',step_started_at:'2026-10-26T00:00:00Z'};
  store.put('orders',order);
  store.put('order_events',{id:'customs',order_id:order.id,step_key:'domestic_customs',started_at:'2026-09-23T00:00:00Z',completed_at:'2026-10-10T00:00:00Z'});
  store.put('order_events',{id:'ocean',order_id:order.id,step_key:'ocean_transit',started_at:'2026-10-10T00:00:00Z',deadline_at:'2026-10-26T00:00:00Z',completed_at:'2026-10-26T00:00:00Z',note:'tracking:OLD-OCEAN'});
  store.put('order_events',{id:'overseas',order_id:order.id,step_key:'overseas_customs',started_at:order.step_started_at,completed_at:null});
  const ctx={flowFor,resetNumberStageNote,shipmentFeatureReady:false,ROLLBACK_COUNT_PATTERN:/\s*\[rollback-count:(\d+)\]/g,api:async(path,options={})=>{const url=new URL(path,'http://local');return store.mutate(url.pathname.split('/').at(-1),options.method||'GET',url,options.body?JSON.parse(options.body):{},user.id)},repairStuckRollback:async()=>{throw Error('Unexpected repair')}};
  const start=source.indexOf('async function rollbackOrder('),end=source.indexOf('\n}\n',start)+3;
  runInNewContext(['stableStepKey','rollbackCountFromRows','noteWithRollbackCount'].map(getFunction).join('\n')+'\n'+source.slice(start,end),ctx);
  await ctx.rollbackOrder(order);
  const rolled=store.all('orders')[0],events=store.all('order_events');
  assert.equal(rolled.current_step,'ocean_transit');
  assert.equal(events.find(row=>row.id==='ocean').note,'[rollback-count:1]');
  assert.equal(currentStageNumber(rolled,'ocean_transit',events),'');
  assert.ok(!events.some(row=>row.step_key==='overseas_customs'));
 } finally {store.db.close();rmSync(dir,{recursive:true,force:true});}
});
