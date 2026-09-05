#!/usr/bin/env bash
set -Eeuo pipefail

test "$(id -u)" -eq 0 || { echo '请使用 sudo 运行'; exit 1; }
SOURCE=/opt/cargo-pulse/server/resource-image-server.mjs
TEMP_SOURCE=''
if [ ! -s "$SOURCE" ]; then
  TEMP_SOURCE="$(mktemp)"
  curl -fsSL "https://raw.githubusercontent.com/newinflatablezone-stack/cargo-pulse/main/server/resource-image-server.mjs?v=$(date +%s)" -o "$TEMP_SOURCE"
  SOURCE="$TEMP_SOURCE"
  trap 'rm -f -- "$TEMP_SOURCE"' EXIT
fi
install -d -m 755 /opt/cargo-pulse-runtime
install -m 644 "$SOURCE" /opt/cargo-pulse-runtime/resource-image-server.mjs
install -d -o www-data -g www-data -m 755 /var/lib/cargo-pulse/uploads/resources
chgrp www-data /etc/cargo-pulse
chmod 750 /etc/cargo-pulse
chgrp www-data /etc/cargo-pulse/config.json
chmod 640 /etc/cargo-pulse/config.json
NODE_BIN="$(command -v node)"
if [ "$NODE_BIN" = /snap/bin/node ] && [ -x /snap/node/current/bin/node ]; then
  # The Snap launcher needs privileges intentionally removed by the hardened
  # systemd unit. Calling the packaged Node binary directly avoids snap-confine.
  NODE_BIN=/snap/node/current/bin/node
fi
"$NODE_BIN" --version >/dev/null

cat >/etc/systemd/system/cargo-pulse-images.service <<EOF
[Unit]
Description=Cargo Pulse Tencent resource image service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=www-data
Group=www-data
ExecStart=$NODE_BIN /opt/cargo-pulse-runtime/resource-image-server.mjs
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/cargo-pulse/uploads
ReadOnlyPaths=/etc/cargo-pulse/config.json

[Install]
WantedBy=multi-user.target
EOF

python3 - <<'PY'
from pathlib import Path
p=Path('/etc/nginx/sites-available/default')
s=p.read_text()
marker='    location = /api/config {'
block='''    location = /api/resource-image {
        client_max_body_size 24k;
        proxy_pass http://127.0.0.1:8787/resource-image$is_args$args;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header Content-Type $content_type;
        proxy_request_buffering off;
    }

    location /uploads/ {
        alias /var/lib/cargo-pulse/uploads/;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        expires 1y;
    }

'''
if 'location = /api/resource-image' not in s:
    if marker not in s: raise SystemExit('未找到 Nginx 插入位置')
    p.with_suffix('.before-images').write_text(s)
    s=s.replace(marker,block+marker)
else:
    s=s.replace('client_max_body_size 18k;', 'client_max_body_size 24k;')
p.write_text(s)
PY

systemctl daemon-reload
systemctl enable cargo-pulse-images.service
systemctl restart cargo-pulse-images.service
nginx -t
systemctl reload nginx

healthy=''
for _ in {1..10}; do
  status="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/not-found || true)"
  if [ "$status" = 404 ]; then
    healthy=1
    break
  fi
  sleep 1
done
if [ -z "$healthy" ]; then
  echo '图片服务启动失败，以下是诊断信息：' >&2
  systemctl status cargo-pulse-images.service --no-pager >&2 || true
  journalctl -u cargo-pulse-images.service -n 50 --no-pager >&2 || true
  exit 1
fi
echo '腾讯云资料图片服务安装完成'
