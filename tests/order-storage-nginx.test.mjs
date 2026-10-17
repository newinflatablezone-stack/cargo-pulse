import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
test('Nginx 私有目录规则覆盖每个站点、可重复执行，且保留公共资料图片',()=>{
 const result=execFileSync('python3',['-c',`
import runpy,tempfile
from pathlib import Path
module=runpy.run_path('deploy/tencent/isolate-order-uploads.py')
with tempfile.TemporaryDirectory() as directory:
 root=Path(directory);(root/'sites-enabled').mkdir()
 path=root/'sites-enabled'/'cargo'
 original='server {\\n    location /uploads/ {\\n        alias /var/lib/cargo-pulse/uploads/;\\n    }\\n}\\n'
 path.write_text(original+original)
 patches=module['prepare_patches'](root)
 updated=patches[path.resolve()][1]
 assert updated.count('location ^~ /uploads/orders/')==2
 assert updated.count('alias /var/lib/cargo-pulse/uploads/;')==2
 assert updated.index('location ^~ /uploads/orders/')<updated.index('location /uploads/')
 path.write_text(updated)
 assert module['prepare_patches'](root)=={}
 print('PASS')
`],{cwd:process.cwd(),encoding:'utf8'});
 assert.match(result,/PASS/);
});
