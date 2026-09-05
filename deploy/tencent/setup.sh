#!/usr/bin/env bash
set -euo pipefail

APP_USER="ubuntu"
APP_REPO="https://github.com/newinflatablezone-stack/cargo-pulse.git"
APP_SOURCE="/opt/cargo-pulse"
APP_ROOT="/var/www/cargo-pulse"
APP_CONFIG_DIR="/etc/cargo-pulse"
VERCEL_CONFIG_URL="https://cargo-pulse-olive.vercel.app/api/config"

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 sudo bash 运行此脚本"
  exit 1
fi

apt-get update
apt-get install -y nginx git rsync curl python3 snapd
systemctl enable --now nginx
systemctl enable --now snapd.socket

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)" -lt 20 ]; then
  if snap list node >/dev/null 2>&1; then
    snap refresh node --channel=22
  else
    snap install node --classic --channel=22
  fi
fi

install -d "$APP_SOURCE" "$APP_ROOT"
chown -R "$APP_USER:$APP_USER" "$APP_SOURCE" "$APP_ROOT"
install -d -m 700 "$APP_CONFIG_DIR"

if [ ! -d "$APP_SOURCE/.git" ]; then
  install -d "$APP_SOURCE"
  chown -R "$APP_USER:$APP_USER" "$APP_SOURCE"
  find "$APP_SOURCE" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  chown "$APP_USER:$APP_USER" "$APP_SOURCE"
  sudo -u "$APP_USER" git clone --branch main --single-branch "$APP_REPO" "$APP_SOURCE"
fi

CONFIG_TMP="$(mktemp)"
curl -fsSL "$VERCEL_CONFIG_URL" -o "$CONFIG_TMP"
python3 - "$CONFIG_TMP" <<'PY'
import json, sys
data=json.load(open(sys.argv[1], encoding="utf-8"))
if not data.get("url") or not data.get("key"):
    raise SystemExit("Supabase 配置为空，停止安装")
PY
install -m 600 "$CONFIG_TMP" "$APP_CONFIG_DIR/config.json"
rm -f "$CONFIG_TMP"

curl -fsSL -H 'Cache-Control: no-cache' \
  "https://raw.githubusercontent.com/newinflatablezone-stack/cargo-pulse/main/deploy/tencent/cargo-pulse-deploy?v=$(date +%s)" \
  -o /usr/local/bin/cargo-pulse-deploy
chmod 755 /usr/local/bin/cargo-pulse-deploy

cat > /etc/nginx/sites-available/default <<'NGINX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    root /var/www/cargo-pulse;
    index index.html;

    location = /api/config {
        default_type application/json;
        add_header Cache-Control "no-store" always;
        try_files /api/config =404;
    }

    location = /api/version {
        default_type application/json;
        add_header Cache-Control "no-store, no-cache, must-revalidate" always;
        try_files /api/version =404;
    }

    location = /index.html {
        add_header Cache-Control "no-store, no-cache, must-revalidate" always;
        try_files $uri =404;
    }

    location / {
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        add_header Pragma "no-cache" always;
        add_header Expires "0" always;
        try_files $uri $uri/ /index.html;
    }
}
NGINX

cat > /etc/systemd/system/cargo-pulse-deploy.service <<'SERVICE'
[Unit]
Description=Deploy Cargo Pulse from GitHub
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/cargo-pulse-deploy
SERVICE

cat > /etc/systemd/system/cargo-pulse-deploy.timer <<'TIMER'
[Unit]
Description=Check GitHub for Cargo Pulse updates every 15 seconds

[Timer]
OnBootSec=10s
OnUnitActiveSec=15s
AccuracySec=1s
Persistent=true

[Install]
WantedBy=timers.target
TIMER

systemctl daemon-reload
systemctl enable --now cargo-pulse-deploy.timer
/usr/local/bin/cargo-pulse-deploy
bash "$APP_SOURCE/deploy/tencent/install-resource-images.sh"
systemctl restart nginx

echo
echo "Cargo Pulse 腾讯云部署完成"
echo "GitHub 自动同步已开启（每 15 秒检查一次）"
