import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TencentDataStore} from '../server/tencent-data-core.mjs';

function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'cargo-issues-')),store=new TencentDataStore(join(dir,'db.sqlite'));
  t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});
  const business=store.upsertAccount({email:'demi@inflatable-zone.com',role:'business'}),other=store.upsertAccount({email:'sherry@inflatable-zone.com',role:'business'}),follower=store.upsertAccount({email:'follow@example.com',role:'follower'}),secondFollower=store.upsertAccount({email:'follow2@example.com',role:'follower'});
  store.put('orders',{id:'o1',order_no:'ORDER-1',business_name:'Demi',current_step:'completed'});
  const call=(user,action,values={})=>store.orderIssues(user.id,{action,...values});
  const create=(key='request-1')=>call(business,'create',{order_id:'o1',body:'Please check delivery',request_id:key});
  return {store,business,other,follower,secondFollower,call,create};
}

test('issue lifecycle: unread, reply, reminder, creator closure and independent counts',t=>{
  const {business,follower,secondFollower,call,create}=fixture(t);
  const issue=create(),second=create('request-2');
  assert.equal(call(business,'summary').total,2);assert.equal(call(follower,'summary').total,2);
  assert.equal(call(follower,'summary').issues[0].unread,true);
  assert.equal(call(business,'summary').issues[0].unread,false);
  call(follower,'read',{issue_id:issue.id,sequence:1});
  assert.equal(call(follower,'order',{order_id:'o1'}).issues.find(x=>x.id===issue.id).unread,false);
  assert.equal(call(secondFollower,'order',{order_id:'o1'}).issues.find(x=>x.id===issue.id).unread,true);
  const answer=call(follower,'reply',{issue_id:issue.id,body:'Delivery confirmed'});
  assert.equal(answer.status,'waiting_business');assert.equal(call(business,'summary').total,2);
  assert.equal(call(business,'order',{order_id:'o1'}).issues.find(x=>x.id===issue.id).unread,true);
  call(business,'read',{issue_id:issue.id,sequence:2});
  call(follower,'remind',{issue_id:issue.id});
  assert.equal(call(business,'order',{order_id:'o1'}).issues.find(x=>x.id===issue.id).unread,true);
  assert.throws(()=>call(follower,'remind',{issue_id:issue.id}),error=>error.status===429);
  assert.throws(()=>call(follower,'close',{issue_id:issue.id}),error=>error.status===403);
  call(business,'close',{issue_id:issue.id});
  assert.equal(call(business,'summary').total,1);assert.equal(call(follower,'summary').total,1);
  assert.equal(call(business,'order',{order_id:'o1'}).issues.length,2);
  assert.equal(call(business,'order',{order_id:'o1'}).issues.find(x=>x.id===second.id).status,'waiting_follower');
  assert.throws(()=>call(follower,'reply',{issue_id:issue.id,body:'late'}),error=>error.status===409);
  call(business,'close',{issue_id:issue.id});assert.equal(call(follower,'summary').total,1);
});

test('business isolation, own-order permission and direct table protection',t=>{
  const {store,business,other,follower,call,create}=fixture(t);const issue=create();
  assert.equal(call(other,'summary').total,0);assert.throws(()=>call(other,'order',{order_id:'o1'}),error=>error.status===404);
  for(const action of ['reply','read','close','remind'])assert.throws(()=>call(other,action,{issue_id:issue.id,body:'hack',sequence:1}),error=>error.status===404);
  for(const actor of [other,follower])assert.throws(()=>call(actor,'create',{order_id:'o1',body:'hack',request_id:'request-3'}),error=>error.status===403);
  for(const table of ['order_issues','order_issue_reads'])for(const method of ['GET','POST','PATCH','DELETE'])assert.throws(()=>store.mutate(table,method,new URL('http://local/rest/v1/'+table),{},follower.id),error=>error.status===403);
  const publicResult=store.homeCoreSnapshot(other.id);assert.equal('issues' in publicResult,false);
  assert.throws(()=>call(business,'create',{order_id:'missing',body:'x',request_id:'request-4'}),error=>error.status===403);
});

test('read receipts cannot swallow later replies or regress, and business followups return to follower',t=>{
  const {business,follower,call,create}=fixture(t);const issue=create();
  call(follower,'reply',{issue_id:issue.id,body:'first'});
  call(follower,'reply',{issue_id:issue.id,body:'second'});
  call(business,'read',{issue_id:issue.id,sequence:2});
  assert.equal(call(business,'order',{order_id:'o1'}).issues[0].unread,true);
  call(business,'read',{issue_id:issue.id,sequence:3});
  call(business,'read',{issue_id:issue.id,sequence:1});
  assert.equal(call(business,'order',{order_id:'o1'}).issues[0].unread,false);
  assert.throws(()=>call(business,'read',{issue_id:issue.id,sequence:99}),error=>error.status===400);
  assert.equal(call(business,'reply',{issue_id:issue.id,body:'Still not fixed'}).status,'waiting_follower');
  assert.throws(()=>call(follower,'remind',{issue_id:issue.id}),error=>error.status===403);
});

test('input validation, retry idempotency, deleted orders, and persisted history',t=>{
  const {store,business,follower,call,create}=fixture(t);
  for(const body of ['', '   ', 'x'.repeat(5001),{}])assert.throws(()=>call(business,'create',{order_id:'o1',body,request_id:'bad-input'}),error=>error.status===400);
  const issue=create();assert.equal(create().id,issue.id);assert.equal(call(business,'summary').total,1);
  store.tableCache.clear();assert.equal(call(follower,'order',{order_id:'o1'}).issues[0].messages[0].body,'Please check delivery');
  const order=store.all('orders')[0];store.put('orders',{...order,deleted_at:new Date().toISOString()});
  assert.equal(call(follower,'summary').total,0);
  assert.throws(()=>call(follower,'reply',{issue_id:issue.id,body:'test'}),error=>error.status===404);
  store.put('orders',{...order,deleted_at:null});assert.equal(call(follower,'summary').total,1);
});

test('issue authors and creators resolve names for historical messages without changing receipts',t=>{
  const {store,business,follower,call,create}=fixture(t);
  const issue=create();
  const staff=[['505863160@qq.com','主管'],['2548462886@qq.com','ICEY'],['1544264271@qq.com','秦枝']];
  for(const [email,name] of staff){
    const actor=store.upsertAccount({email,role:'follower'});
    const result=call(actor,'reply',{issue_id:issue.id,body:'Checking'});
    assert.equal(result.messages.at(-1).author_name,name);
    assert.equal(call(actor,'order',{order_id:'o1'}).issues[0].creator_name,'Demi');
  }
  assert.equal(call(follower,'summary').issues[0].creator_name,'Demi');
  const stored=store.all('order_issues')[0];
  assert.equal('author_name' in stored.messages[0],false);
  assert.equal(call(follower,'order',{order_id:'o1'}).issues[0].messages[0].author_name,'Demi');
  store.put('profiles',{...store.profile(follower.id),display_name:'小林'});
  assert.equal(call(follower,'reply',{issue_id:issue.id,body:'Reply'}).messages.at(-1).author_name,'小林');
  assert.equal(store.issueDisplayName('deleted','2548462886@qq.com','follower'),'ICEY');
  assert.equal(store.issueDisplayName('missing','unknown@example.com','follower'),'跟单');
  store.put('profiles',{...store.profile(follower.id),display_name:'mail@example.com'});
  assert.equal(store.issueDisplayName(follower.id),'跟单');
  assert.equal(call(business,'summary').issues[0].unread,true);
});

test('after-sales reaches followers and supervisor, stays separate and retains resolved history',t=>{
  const {store,business,other,follower,call,create}=fixture(t);
  const supervisor=store.upsertAccount({email:'505863160@qq.com',role:'follower'});
  const sales=(user,action,values={})=>call(user,action,{category:'after_sales',...values});
  store.put('partners',{id:'factory-a',kind:'factory',name:'Factory A',active:true});
  store.put('partners',{id:'factory-b',kind:'factory',name:'Factory B',active:false});
  store.put('partners',{id:'forwarder-a',kind:'forwarder',name:'Forwarder A',active:true});
  const eligible=sales(business,'eligible_orders');
  assert.deepEqual(eligible.orders.map(order=>order.id),['o1']);
  assert.deepEqual(eligible.factories,['Factory A']);
  assert.deepEqual(sales(other,'eligible_orders').orders,[]);
  assert.deepEqual(sales(follower,'eligible_orders').orders,[]);
  assert.equal(sales(supervisor,'summary').can_create,false);
  const general=create();
  assert.throws(()=>sales(business,'create',{order_id:'o1',body:'Replacement requested',request_id:'request-1'}),error=>error.status===400);
  const issue=sales(business,'create',{order_id:'o1',factory:' Factory A ',body:'Replacement requested',request_id:'request-1'});
  assert.equal(issue.factory,'Factory A');
  assert.notEqual(issue.id,general.id);
  assert.equal(call(follower,'summary').total,1);
  const combined=call(follower,'summary',{include_after_sales:true});
  assert.equal(combined.total,2);
  assert.equal(combined.issues.find(row=>row.id===issue.id).category,'after_sales');
  assert.equal(call(other,'summary',{include_after_sales:true}).total,0);
  assert.equal(sales(follower,'summary').issues[0].unread,true);
  assert.equal(sales(supervisor,'summary').issues[0].unread,true);
  assert.equal(sales(other,'summary').total,0);
  assert.throws(()=>sales(other,'order',{order_id:'o1'}),error=>error.status===404);
  assert.throws(()=>call(follower,'reply',{issue_id:issue.id,body:'Wrong category'}),error=>error.status===404);
  sales(follower,'reply',{issue_id:issue.id,body:'Replacement sent'});
  assert.equal(sales(business,'summary').issues[0].status,'waiting_business');
  sales(business,'close',{issue_id:issue.id});
  const combinedAfterClose=call(supervisor,'summary',{include_after_sales:true});
  assert.equal(combinedAfterClose.total,1);
  assert.equal(combinedAfterClose.issues.some(row=>row.id===issue.id),false);
  const resolved=sales(supervisor,'summary');
  assert.equal(resolved.total,0);
  assert.equal(resolved.issues[0].status,'closed');
  assert.equal(resolved.issues[0].factory,'Factory A');
  sales(supervisor,'read',{issue_id:issue.id,sequence:resolved.issues[0].sequence});
  assert.equal(sales(supervisor,'summary').issues[0].unread,false);
  assert.equal(call(follower,'summary').total,1);
});

test('Shopify intake deduplicates numbers and enforces claim and handoff roles',t=>{
  const {store,business,other,follower}=fixture(t);
  const imported={id:'shopify-1',order_no:' #123 ',order_date:'2026-11-21',size:'',image_urls:[]};
  const call=(user,action,values={})=>store.shopifyIntake(user.id,{action,...values});
  store.put('shopify_order_intake',imported);
  assert.equal(store.importShopifyOrder({...imported,id:'duplicate-existing',order_no:'#ORDER-1'}),null);
  assert.equal(store.all('shopify_order_intake').length,1);
  assert.equal(call(business,'list').orders.length,1);
  assert.equal(call(other,'list').orders.length,1);
  assert.throws(()=>call(follower,'list'),error=>error.status===403);
  assert.throws(()=>call(business,'submit',{id:imported.id}),error=>error.status===403);
  call(business,'claim',{id:imported.id});
  assert.equal(call(other,'list').orders.length,0);
  assert.throws(()=>call(other,'claim',{id:imported.id}),error=>error.status===409);
  assert.throws(()=>call(business,'submit',{id:imported.id}),error=>error.status===400);
  const {id}=call(business,'submit',{id:imported.id,order_date:'2026-11-21',product_name:'Inflatable',
    quantity:'1',size:'2 x 3 m',customer_info:'Delivery address',blower:'不包含',shipping_mode:'domestic_sea'});
  assert.equal(call(business,'list').orders.length,0);
  const order=store.visibleRows('orders',follower.id).find(row=>row.id===id);
  assert.equal(order.current_step,'business_placed');
  assert.equal(order.business_id,business.id);
  assert.equal(order.shopify_shared,undefined);
  assert.equal(store.canReadOrder(business.id,order),true);
  assert.equal(store.canReadOrder(other.id,order),false);
  assert.equal(store.all('order_events').find(row=>row.order_id===id).step_key,'business_placed');
  assert.throws(()=>call(business,'submit',{id:imported.id}),error=>error.status===409);
});
