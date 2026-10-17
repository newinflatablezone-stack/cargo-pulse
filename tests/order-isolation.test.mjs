import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TencentDataStore} from '../server/tencent-data-core.mjs';
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'cargo-owned-')),store=new TencentDataStore(join(dir,'db.sqlite'));
 t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});
 const a=store.upsertAccount({email:'sales@inflatable-zone.com',role:'business'}),b=store.upsertAccount({email:'sherry@inflatable-zone.com',role:'business'}),f=store.upsertAccount({email:'follow@example.com',role:'follower'}),admin=store.upsertAccount({email:'505863160@qq.com',role:'follower'});
 const data=[{id:'a',business_name:'Ella'},{id:'b',business_name:'Sherry',created_by:a.id},{id:'explicit',business_name:'Sherry',business_id:a.id},{id:'conflict',business_name:'Ella',business_id:a.id,business_user_id:b.id},{id:'unknown',business_name:'Unknown'},{id:'deleted',business_name:'Ella',deleted_at:'2026-01-01'}];
 for(const row of data){store.put('orders',{...row,order_no:row.id,current_step:'production'});for(const table of ['order_events','order_images','order_factories','order_shipments'])store.put(table,{id:row.id,order_id:row.id,step_key:'production',completed_at:null,note:'tracking:'+row.id,object_path:row.id+'/delivery-proof-test.png'});store.put('order_shipment_events',{id:row.id,shipment_id:row.id,step_key:'production'});}
 return {store,a,b,f,admin};
}
test('四个业务邮箱对应自己的历史订单；显式账号优先，创建人不覆盖负责人',t=>{
 const {store,a,b}=fixture(t);
 assert.deepEqual(store.visibleRows('orders',a.id).map(o=>o.id),['a','explicit']);
 assert.deepEqual(store.visibleRows('orders',b.id).map(o=>o.id),['b']);
 for(const [email,name] of [['demi@inflatable-zone.com','Demi'],['rayna@inflatable-zone.com','Rayna']]){const user=store.upsertAccount({email,role:'business'});const order=store.put('orders',{id:name,business_name:name});assert.equal(store.canReadOrder(user.id,order),true);assert.equal(store.canReadOrder(a.id,order),false);}
 const spoof=store.upsertAccount({email:'Ella@other.example',role:'business'});assert.equal(store.canReadOrder(spoof.id,store.all('orders')[0]),false);
 const duplicate=store.upsertAccount({email:'duplicate@example.com',role:'business'});store.put('profiles',{...duplicate,display_name:'Ella'});assert.equal(store.canReadOrder(a.id,store.all('orders')[0]),false);
});
test('快照、所有关联表、直接查询、无主键投影及分页均先按订单权限隔离',t=>{
 const {store,a,b,f,admin}=fixture(t);
 const snapshot=store.homeSnapshot(a.id);assert.deepEqual(snapshot.orders.map(o=>o.id),['a','explicit']);
 for(const field of ['images','tracking_events','active_events','factories','shipments'])assert.deepEqual(snapshot[field].map(r=>r.order_id),['a','explicit']);
 for(const table of ['orders','order_events','order_images','order_factories','order_shipments','order_shipment_events']){
  const url=new URL('http://local/rest/v1/'+table+'?select=id&order=id&limit=1&offset=1');
  assert.deepEqual(store.mutate(table,'GET',url,{},a.id),[{id:'explicit'}]);
  const guessed=new URL('http://local/rest/v1/'+table+'?id=eq.b&select=note,object_path');assert.deepEqual(store.mutate(table,'GET',guessed,{},a.id),[]);
  const range=new URL('http://local/rest/v1/'+table+'?select=id&order=id');assert.deepEqual(store.mutate(table,'GET',range,{},a.id,'','1-1'),[{id:'explicit'}]);
  assert.equal(store.mutate(table,'GET',new URL('http://local/rest/v1/'+table),{},b.id).length,1);
 }
 assert.equal(store.homeSnapshot(f.id).orders.length,5);assert.equal(store.homeSnapshot(admin.id).orders.length,6);
 assert.deepEqual(store.homeRelationsSnapshot().shipments,[]);
 assert.equal(store.canReadObject(a.id,'a/delivery-proof-test.png'),true);assert.equal(store.canReadObject(a.id,'b/delivery-proof-test.png'),false);assert.equal(store.canReadObject(a.id,'a/guessed.png'),false);
});
test('订单转交后，旧负责人失去问题汇总、详情、操作和签名权限；新负责人接管',t=>{
 const {store,a,b,f}=fixture(t),call=(user,action,extra={})=>store.orderIssues(user.id,{action,...extra});
 const issue=call(a,'create',{order_id:'a',request_id:'request-transfer',body:'problem'});
 call(f,'reply',{issue_id:issue.id,body:'answer'});
 assert.equal(call(a,'summary').total,1);assert.equal(call(b,'summary').total,0);
 const row=store.all('orders').find(o=>o.id==='a');store.put('orders',{...row,business_id:b.id});
 assert.equal(call(a,'summary').total,0);assert.equal(call(b,'summary').total,1);
 assert.throws(()=>call(a,'order',{order_id:'a'}),{status:404});
 for(const action of ['read','reply','close'])assert.throws(()=>call(a,action,{issue_id:issue.id,sequence:1,body:'attempt'}),{status:404});
 assert.equal(store.canReadObject(a.id,'a/delivery-proof-test.png'),false);
 assert.equal(call(b,'order',{order_id:'a'}).issues[0].can_close,true);
 call(b,'close',{issue_id:issue.id});assert.equal(call(b,'summary').total,0);
 assert.throws(()=>call(a,'create',{order_id:'explicit',request_id:'request-transfer',body:'reuse old key'}),{status:404});
});
test('跟单通过表单改负责业务员时同步更新账号绑定，不沿用旧负责人ID',t=>{
 const {store,a,b,f}=fixture(t);
 const url=new URL('http://local/rest/v1/orders?id=eq.explicit');
 const result=store.mutate('orders','PATCH',url,{business_name:'Sherry'},f.id)[0];
 assert.equal(result.business_id,b.id);assert.equal(store.canReadOrder(a.id,result),false);assert.equal(store.canReadOrder(b.id,result),true);
 const unknown=store.mutate('orders','PATCH',url,{business_name:'Unresolved'},f.id)[0];
 assert.equal(unknown.business_id,null);assert.equal(store.canReadOrder(b.id,unknown),false);assert.equal(store.canReadOrder(f.id,unknown),true);
});
