#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 sudo bash 运行此脚本"
  exit 1
fi

TIMER_FILE="/etc/systemd/system/cargo-pulse-deploy.timer"
if [ ! -f "$TIMER_FILE" ]; then
  echo "未找到 Cargo Pulse 自动部署定时器"
  exit 1
fi

python3 - <<'PY'
from pathlib import Path
p = Path("/etc/systemd/system/cargo-pulse-deploy.timer")
s = p.read_text()
s = s.replace("Description=Check GitHub for Cargo Pulse updates every minute", "Description=Check GitHub for Cargo Pulse updates every 15 seconds")
s = s.replace("OnBootSec=30s", "OnBootSec=10s")
s = s.replace("OnUnitActiveSec=60s", "OnUnitActiveSec=15s")
s = s.replace("AccuracySec=5s", "AccuracySec=1s")
p.write_text(s)
PY

rm -f /etc/nginx/conf.d/cargo-pulse-fresh-assets.conf
rm -f /etc/nginx/conf.d/cargo-pulse-compression.conf

python3 - <<'PY'
from pathlib import Path
p = Path('/etc/nginx/sites-available/default')
s = p.read_text()
block = '''    location ^~ /assets/ {
        gzip on;
        gzip_vary on;
        gzip_comp_level 5;
        gzip_types text/css application/javascript application/json image/svg+xml;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        expires 1y;
        try_files $uri =404;
    }

'''
if 'location ^~ /assets/' not in s:
    marker = '    location / {'
    if marker not in s:
        raise SystemExit('未找到 Nginx 静态资源插入位置')
    p.with_suffix('.before-performance').write_text(s)
    s = s.replace(marker, block + marker, 1)
elif 'location ^~ /assets/ {\n        gzip on;' not in s:
    s = s.replace('    location ^~ /assets/ {\n', '    location ^~ /assets/ {\n        gzip on;\n        gzip_vary on;\n        gzip_comp_level 5;\n        gzip_types text/css application/javascript application/json image/svg+xml;\n', 1)
p.write_text(s)
PY

systemctl daemon-reload
systemctl restart cargo-pulse-deploy.timer
nginx -t
systemctl reload nginx
systemctl start cargo-pulse-deploy.service

echo "Cargo Pulse 快速更新已启用：首页实时更新，版本化静态资源已压缩并长期缓存。"
