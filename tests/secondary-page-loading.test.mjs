import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../app-v2.js',import.meta.url),'utf8');
for(const name of ['loadTencentHomeRelations','loadSupplementalHomeData','loadActiveHomeData','loadHomeRelations']){
 for(const secondary of [true,false])test(name+(secondary?' preserves an open secondary page':' updates the order center'),async()=>{
  let renders=0,rebuilds=0;
  const ctx={refreshRevision:1,api:async()=>name==='loadTencentHomeRelations'?{images:[{order_id:'test'}]}:[],allRows:async()=>[],optionalRows:async()=>({rows:[],ready:true}),workInProgress:()=>false,secondaryPageOpen:()=>secondary,rebuildOrderIndexes:()=>rebuilds++,render:()=>renders++,loadSupplementalHomeData:async()=>{},console};
  const fn=source.split('\n').find(line=>line.startsWith('async function '+name+'('));
  runInNewContext(fn,ctx);await ctx[name](1);
  assert.equal(rebuilds,1);assert.equal(renders,secondary?0:1);
  if(secondary)assert.equal(ctx.pendingLiveSync,true);
 });
}
