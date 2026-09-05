import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const configPath=process.env.CARGO_PULSE_CONFIG||'/etc/cargo-pulse/config.json';
const uploadRoot=process.env.CARGO_PULSE_UPLOAD_ROOT||'/var/lib/cargo-pulse/uploads';
const config=JSON.parse(await readFile(configPath,'utf8'));
const authCache=new Map();
const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body))};
async function authenticatedFollower(req){const authorization=req.headers.authorization||'',cached=authCache.get(authorization);if(cached>Date.now())return true;if(!authorization.startsWith('Bearer '))return false;const userResponse=await fetch(`${config.url}/auth/v1/user`,{headers:{apikey:config.key,authorization}});if(!userResponse.ok)return false;const user=await userResponse.json(),profileResponse=await fetch(`${config.url}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=role`,{headers:{apikey:config.key,authorization}});if(!profileResponse.ok)return false;const profiles=await profileResponse.json(),allowed=profiles[0]?.role==='follower';if(allowed)authCache.set(authorization,Date.now()+5*60*1000);return allowed}
async function readBody(req,limit){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw Error('图片超过 20KB');chunks.push(chunk)}return Buffer.concat(chunks)}
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://127.0.0.1');if(req.method!=='POST'||url.pathname!=='/resource-image')return send(res,404,{error:'not found'});if(!await authenticatedFollower(req))return send(res,403,{error:'没有上传权限'});const key=url.searchParams.get('key');if(!['inventory','logistics'].includes(key))return send(res,400,{error:'资料类型无效'});const type=String(req.headers['content-type']||'');if(!['image/webp','image/jpeg','image/png'].includes(type))return send(res,415,{error:'仅支持 WebP、JPEG、PNG 图片'});const bytes=await readBody(req,20*1024),extension=type==='image/webp'?'webp':type==='image/jpeg'?'jpg':'png',relativePath=`resources/${key}/${randomUUID()}.${extension}`,target=path.join(uploadRoot,...relativePath.split('/'));await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes,{flag:'wx'});return send(res,201,{object_path:`tencent:${relativePath}`,url:`/uploads/${relativePath}`})}catch(error){return send(res,/20KB/.test(error.message)?413:500,{error:error.message||'上传失败'})}});
server.listen(8787,'127.0.0.1',()=>console.log('Cargo Pulse resource image service listening on 127.0.0.1:8787'));
