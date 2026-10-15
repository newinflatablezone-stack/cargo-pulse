import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');
const ticketAppSource = readFileSync(new URL('../public/tickets/app.js', import.meta.url), 'utf8');
const embeddedTicketSource = readFileSync(new URL('../public/tickets/embedded.js', import.meta.url), 'utf8');
const compactTicketStyle = readFileSync(new URL('../public/tickets/compact.css', import.meta.url), 'utf8');

test('待处理工单固定显示红色提醒标记', () => {
  assert.match(ticketAppSource, /pending:'待处理'/);
  assert.match(embeddedTicketSource, /pending:'待处理'/);
  assert.match(compactTicketStyle, /status-tag\.status-pending::before/);
});

test('工单列表只显示紧急等级并统一状态标记尺寸', () => {
  assert.match(compactTicketStyle, /#categoryFilter,#teCategory\{display:none\}/);
  assert.match(compactTicketStyle, /\.tickets td:nth-child\(3\)>\.tag:first-child\{display:none\}/);
  assert.match(compactTicketStyle, /content:"等级"/);
  assert.match(compactTicketStyle, /min-width:64px/);
  assert.match(compactTicketStyle, /\.tickets th:nth-child\(2\),\.tickets td:nth-child\(2\)\{display:none!important\}/);
});

test('工单 Shadow DOM 挂载到可移除子容器，切换其他后台页面不会被旧页面覆盖', () => {
  assert.match(source, /class="ticket-page-host"/);
  assert.match(source, /mountTicketPage\(host,/);
  assert.doesNotMatch(source, /mountTicketPage\(page,/);
  assert.match(source, /page\.applyTicketNotificationSnapshot=snapshot=>host\.applyTicketNotificationSnapshot/);
});

import { runInNewContext } from 'node:vm';

function ticketContext(loadTicketModule) {
  let replacements=0;
  const host={syncTicketRoute(){},applyTicketNotificationSnapshot(){},openTicket(){}};
  const page={querySelector:()=>host};
  Object.defineProperty(page,'innerHTML',{configurable:true,set(){replacements++;}});
  let current=page;
  const context={session:{user:{id:'sales'}},location:{pathname:'/',search:'?resource=tickets'},URLSearchParams,history:{pushState(){}},$:()=>current,loadTicketModule,ticketNotifications:[],applyTicketNotificationSnapshot(){},render(){},resumePendingLiveSync(){},esc:String};
  const helper=source.split('\n').find(line=>line.startsWith('function preserveTicketPage('));
  const start=source.indexOf('async function openTicketResource('),end=source.indexOf('\nasync function openInternalResource(',start);
  runInNewContext(helper+'\n'+source.slice(start,end),context);
  return {context,page,host,replacements:()=>replacements,leave(){current={};context.location.search='';}};
}

test('工单重复打开和后台刷新复用同一个挂载，保留当前页面',async()=>{
  let mounts=0,release;
  const gate=new Promise(resolve=>{release=resolve});
  const fixture=ticketContext(async()=>({mountTicketPage:async()=>{mounts++;await gate;}}));
  const first=fixture.context.openTicketResource(false);
  const second=fixture.context.openTicketResource(false);
  await Promise.resolve();
  assert.equal(fixture.context.preserveTicketPage(),true);
  release();await Promise.all([first,second]);
  await fixture.context.openTicketResource(false);
  assert.equal(mounts,1);
  assert.equal(fixture.replacements(),1);
  fixture.context.session={user:{id:'other-user'}};
  assert.equal(fixture.context.preserveTicketPage(),false);
  fixture.context.session=null;
  assert.equal(fixture.context.preserveTicketPage(),false);
});

test('工单模块延迟加载时离开页面，旧回调不会覆盖新页面',async()=>{
  let mounts=0,release;
  const module=new Promise(resolve=>{release=resolve});
  const fixture=ticketContext(()=>module);
  const pending=fixture.context.openTicketResource(false);
  fixture.leave();release({mountTicketPage:async()=>{mounts++;}});
  await pending;
  assert.equal(mounts,0);
  assert.equal(fixture.context.preserveTicketPage(),false);
});

for(const file of ['embedded.js','app.js']){
  test(`工单 ${file} 后台通知订阅只更新按钮，不重建列表或编辑表单`,async()=>{
    const text=readFileSync(new URL('../public/tickets/'+file,import.meta.url),'utf8');
    const start=text.indexOf('async function syncPush('),end=text.indexOf('\n  const enablePush',start)>0?text.indexOf('\n  const enablePush',start):text.indexOf('\nconst enablePush',start);
    const button={textContent:'开启通知',disabled:true};let renders=0;
    const subscription={options:{applicationServerKey:new Uint8Array([1,2,3])},toJSON:()=>({endpoint:'synthetic-test'})};
    const registration={pushManager:{getSubscription:async()=>subscription}};
    const ctx={data:{push:{available:true,public_key:'test'}},isMobileDevice:()=>false,isIOSDevice:()=>false,window:{PushManager:true,Notification:true},Notification:{permission:'granted'},navigator:{serviceWorker:{register:async()=>registration,ready:Promise.resolve(registration)}},pushKey:()=>new Uint8Array([1,2,3]),samePushKey:(a,b)=>String(a)===String(b),rpc:async()=>({available:true}),render:()=>{renders++;},pushButtonLabel:()=> '通知已开启',document:{querySelector:()=>button},q:()=>button};
    const update=text.split('\n').find(line=>line.trim().startsWith('function updatePushButton('));
    runInNewContext(update+'\n'+text.slice(start,end),ctx);
    await ctx.syncPush();
    assert.equal(renders,0);
    assert.equal(button.textContent,'通知已开启');
    assert.equal(button.disabled,false);
  });
}

test('同一个 main 切换到其他资源后，重新进入工单会重新挂载有效容器',async()=>{
  let mounts=0;
  const fixture=ticketContext(async()=>({mountTicketPage:async()=>{mounts++;}}));
  await fixture.context.openTicketResource(false);
  fixture.page.querySelector=()=>null;
  assert.equal(fixture.context.preserveTicketPage(),false);
  // Opening the page replaces the old resource content with a fresh host.
  Object.defineProperty(fixture.page,'innerHTML',{configurable:true,set(){fixture.page.querySelector=()=>fixture.host;}});
  await fixture.context.openTicketResource(false);
  assert.equal(mounts,2);
});
