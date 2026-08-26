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

cat > /etc/nginx/conf.d/cargo-pulse-fresh-assets.conf <<'NGINX'
add_header Cache-Control "no-cache, no-store, must-revalidate" always;
add_header Pragma "no-cache" always;
add_header Expires "0" always;
NGINX

systemctl daemon-reload
systemctl restart cargo-pulse-deploy.timer
nginx -t
systemctl reload nginx
systemctl start cargo-pulse-deploy.service

echo "Cargo Pulse 快速更新已启用：每 15 秒检查，并禁止页面使用旧缓存。"
