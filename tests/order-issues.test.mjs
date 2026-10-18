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
