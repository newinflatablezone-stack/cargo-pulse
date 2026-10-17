import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
test('旧的全量缓存和过期归属缓存不会在任何账号登录时再次显示',()=>{
 const source=readFileSync(new URL('../app-v2.js',import.meta.url),'utf8');
 const storage={cp_home_a:'all old orders',cp_home_owned_v1_b:'old ownership',cp_session:'preserve session',cp_config:'preserve configuration'};
 Object.defineProperty(storage,'removeItem',{enumerable:false,value(key){delete this[key];}});
 Object.defineProperty(storage,'setItem',{enumerable:false,value(){assert.fail('Order snapshots must not be persisted');}});
 const ctx={localStorage:storage,orders:[],ordersReady:true};
 const functions=['hydrateCachedHome','cacheHomeData'].map(name=>source.split('\n').find(line=>line.startsWith('function '+name+'('))).join('\n');
 runInNewContext(functions,ctx);
 assert.equal(ctx.hydrateCachedHome(),false);ctx.cacheHomeData();
 assert.deepEqual(Object.keys(storage),['cp_session','cp_config']);assert.deepEqual(ctx.orders,[]);
});
