import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {TencentDataStore} from '../server/tencent-data-core.mjs';

test('真实 HTTP：业务员互相不可见，图片链接绑定登录人，转交及退出后立即拒绝旧访问',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'cargo-wall-http-'));
 const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;socket.close();await once(socket,'close');
 const db=join(directory,'data.sqlite'),uploads=join(directory,'uploads'),store=new TencentDataStore(db);
 const a=store.upsertAccount({email:'sales@inflatable-zone.com',password:'password-a',role:'business'}),b=store.upsertAccount({email:'sherry@inflatable-zone.com',password:'password-b',role:'business'});
 const sessionA=store.issueSession(a),sessionB=store.issueSession(b);
 for(const user of [a,b]){
  const id=user===a?'a':'b';store.put('orders',{id,business_id:user.id,current_step:'production',order_no:id});
  store.put('order_images',{id,order_id:id,object_path:id+'/delivery-proof-test.png'});
  store.put('order_events',{id,order_id:id,step_key:'production',note:'tracking:'+id,completed_at:null});
  mkdirSync(join(uploads,id),{recursive:true});writeFileSync(join(uploads,id,'delivery-proof-test.png'),'private-image-'+id);
 }
 const child=spawn(process.execPath,[resolve('server/tencent-data-server.mjs')],{env:{...process.env,PORT:String(port),CARGO_PULSE_DATA_DIR:directory,CARGO_PULSE_DB:db,CARGO_PULSE_ORDER_UPLOADS:uploads,LEGACY_SUPABASE_URL:'',LEGACY_SUPABASE_KEY:''},stdio:'ignore'});
 const base='http://127.0.0.1:'+port;
 const headers=session=>({Authorization:'Bearer '+session.access_token,'Content-Type':'application/json'});
 const rpc=(name,session,body={})=>fetch(base+'/rest/v1/rpc/'+name,{method:'POST',headers:headers(session),body:JSON.stringify(body)});
 try{
  let ready=false;
  for(let i=0;i<50;i++){try{const r=await fetch(base+'/health');if(r.ok){assert.deepEqual(await r.json(),{ok:true});ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}
  assert.ok(ready,'server started');
  for(const [session,id,foreign] of [[sessionA,'a','b'],[sessionB,'b','a']]){
   for(const route of ['home_core','home_bootstrap','list_visible_orders']){const response=await rpc(route,session);assert.equal(response.status,200);const data=await response.json();assert.deepEqual((Array.isArray(data)?data:data.orders).map(row=>row.id),[id]);}
   const relations=await rpc('home_relations',session).then(r=>r.json());assert.deepEqual(relations.images.map(row=>row.order_id),[id]);assert.deepEqual(relations.active_events.map(row=>row.order_id),[id]);
   const guessed=await fetch(base+'/rest/v1/orders?id=eq.'+foreign+'&select=customer_info,order_no',{headers:headers(session)});assert.deepEqual(await guessed.json(),[]);
   const issue=await rpc('order_issues',session,{action:'order',order_id:foreign});assert.equal(issue.status,404);
   const forbidden=await fetch(base+'/storage/v1/object/sign/order-images/'+foreign+'/delivery-proof-test.png',{method:'POST',headers:headers(session),body:'{}'});assert.equal(forbidden.status,404);
  }
  const signing=await fetch(base+'/storage/v1/object/sign/order-images/a/delivery-proof-test.png',{method:'POST',headers:headers(sessionA),body:'{}'});assert.equal(signing.status,200);
  const signed=base+'/storage/v1'+(await signing.json()).signedURL,cookie=signing.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(signed)).status,404);
  assert.equal((await fetch(signed,{headers:headers(sessionB)})).status,404);
  const image=await fetch(signed,{headers:{Cookie:cookie}});assert.equal(image.status,200);assert.equal(await image.text(),'private-image-a');assert.equal(image.headers.get('cache-control'),'private, no-store');
  const loginB=await fetch(base+'/auth/v1/token?grant_type=password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:b.email,password:'password-b'})});assert.equal(loginB.status,200);
  const cookieB=loginB.headers.get('set-cookie').split(';')[0];assert.equal((await fetch(signed,{headers:{Cookie:cookieB}})).status,404);
  // A signed link is re-authorized against the live ownership record on every read.
  store.put('orders',{...store.all('orders').find(row=>row.id==='a'),business_id:b.id});
  assert.equal((await fetch(signed,{headers:{Cookie:cookie}})).status,404);
  assert.deepEqual((await rpc('home_core',sessionA).then(r=>r.json())).orders,[]);
  const logout=await fetch(base+'/auth/v1/logout',{method:'POST',headers:headers(sessionA),body:JSON.stringify({refresh_token:sessionA.refresh_token})});assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await rpc('home_core',sessionA)).status,401);
  assert.equal(store.session(sessionA.refresh_token,'refresh'),null);
 }finally{
  const ended=once(child,'exit');child.kill();await ended;store.db.close();rmSync(directory,{recursive:true,force:true});
 }
});
