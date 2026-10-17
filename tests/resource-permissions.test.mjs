import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../app-v2.js',import.meta.url),'utf8');
const start=source.indexOf('let internalResourceAccess='),end=source.indexOf('\nasync function openInternalResource(',start);
function context(api){const ctx={session:{user:{id:'follower'}},profile:{role:'business'},api,SUPERVISOR_EMAIL:'505863160@qq.com'};runInNewContext(source.slice(start,end),ctx);return ctx;}
test('表格编辑权限来自服务端，忽略首页旧的业务员缓存并支持权限收回',async()=>{
 let allowed=true,calls=0;
 const ctx=context(async()=>{calls++;return {can_edit:allowed};});
 assert.equal(ctx.canEditInternalResources(),false);
 await ctx.loadInternalResourcePermissions();
 assert.equal(ctx.canEditInternalResources(),true);
 allowed=false;await ctx.loadInternalResourcePermissions();
 assert.equal(ctx.canEditInternalResources(),false);
 assert.equal(calls,2);
});
test('账号切换后不会复用其他账号的权限，也不接受旧账号迟到的响应',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});
 const ctx=context(()=>gate);const pending=ctx.loadInternalResourcePermissions();
 ctx.session={user:{id:'business'}};release({can_edit:true});
 await assert.rejects(pending,/账号已切换/);
 assert.equal(ctx.canEditInternalResources(),false);
});
test('旧后端兼容通过查询本人的资料授予跟单权限',async()=>{
 const ctx=context(async path=>{if(path.includes('/rpc/'))throw Object.assign(Error('missing'),{status:404});return [{id:'follower',role:'follower',email:'follower@example.com'}];});
 await ctx.loadInternalResourcePermissions();assert.equal(ctx.canEditInternalResources(),true);
});
