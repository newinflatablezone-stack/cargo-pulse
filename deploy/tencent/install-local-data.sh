#!/usr/bin/env bash
set -Eeuo pipefail

test "$(id -u)" -eq 0 || { echo '请使用 sudo 运行'; exit 1; }
SOURCE="${SOURCE:-/opt/cargo-pulse}"
RUNTIME=/opt/cargo-pulse-runtime
CONFIG_DIR=/etc/cargo-pulse
DATA_DIR=/var/lib/cargo-pulse/data
TEMP_SOURCE=''

if [ ! -s "$SOURCE/server/tencent-data-server.mjs" ]; then
  TEMP_SOURCE="$(mktemp -d)"
  trap 'rm -rf -- "$TEMP_SOURCE"' EXIT
  git -C /opt/cargo-pulse archive origin/main \
    server/tencent-data-core.mjs server/tencent-data-server.mjs \
    scripts/migrate-supabase-to-tencent.mjs scripts/backup-tencent-data.mjs \
    deploy/tencent/cargo-pulse-deploy | tar -xf - -C "$TEMP_SOURCE"
  SOURCE="$TEMP_SOURCE"
fi

test -s "$CONFIG_DIR/config.json" || { echo '找不到现有系统配置'; exit 1; }
install -d -m 750 "$CONFIG_DIR" "$RUNTIME"
install -d -o www-data -g www-data -m 750 "$DATA_DIR" /var/lib/cargo-pulse/uploads/orders
cp -n "$CONFIG_DIR/config.json" "$CONFIG_DIR/legacy-config.json"
install -m 644 "$SOURCE/server/tencent-data-core.mjs" "$RUNTIME/tencent-data-core.mjs"
install -m 644 "$SOURCE/server/tencent-data-server.mjs" "$RUNTIME/tencent-data-server.mjs"
install -m 644 "$SOURCE/scripts/migrate-supabase-to-tencent.mjs" "$RUNTIME/migrate-supabase-to-tencent.mjs"
install -m 644 "$SOURCE/scripts/backup-tencent-data.mjs" "$RUNTIME/backup-tencent-data.mjs"
install -m 755 "$SOURCE/deploy/tencent/cargo-pulse-deploy" /usr/local/bin/cargo-pulse-deploy
for file in \
  "$RUNTIME/tencent-data-core.mjs" \
  "$RUNTIME/tencent-data-server.mjs" \
  "$RUNTIME/migrate-supabase-to-tencent.mjs" \
  "$RUNTIME/backup-tencent-data.mjs"; do
  test -s "$file" || { echo "运行文件安装失败：$file" >&2; exit 1; }
done

IMPORT_SECRET="$(openssl rand -hex 32)"
python3 - "$CONFIG_DIR/legacy-config.json" "$CONFIG_DIR/local-data.env" "$IMPORT_SECRET" <<'PY'
import json,shlex,sys
cfg=json.load(open(sys.argv[1],encoding='utf-8'))
if not cfg.get('url') or not cfg.get('key'): raise SystemExit('旧数据配置不完整')
values={
 'PORT':'8788',
 'CARGO_PULSE_DATA_DIR':'/var/lib/cargo-pulse/data',
 'CARGO_PULSE_ORDER_UPLOADS':'/var/lib/cargo-pulse/uploads/orders',
 'CARGO_PULSE_IMPORT_SECRET':sys.argv[3],
 'LEGACY_SUPABASE_URL':cfg['url'],
 'LEGACY_SUPABASE_KEY':cfg['key'],
}
with open(sys.argv[2],'w',encoding='utf-8') as f:
 for k,v in values.items(): f.write(f'{k}={shlex.quote(str(v))}\n')
PY
chmod 640 "$CONFIG_DIR/local-data.env"
chown root:www-data "$CONFIG_DIR/local-data.env"

NODE_BIN="$(command -v node)"
if [ "$NODE_BIN" = /snap/bin/node ] && [ -x /snap/node/current/bin/node ]; then NODE_BIN=/snap/node/current/bin/node; fi
cat > /etc/systemd/system/cargo-pulse-data.service <<EOF
[Unit]
Description=Cargo Pulse Tencent local data service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=www-data
Group=www-data
EnvironmentFile=$CONFIG_DIR/local-data.env
ExecStart=$NODE_BIN $RUNTIME/tencent-data-server.mjs
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/cargo-pulse/data /var/lib/cargo-pulse/uploads/orders

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/cargo-pulse-data-backup.service <<EOF
[Unit]
Description=Backup Cargo Pulse Tencent database and uploads

[Service]
Type=oneshot
EnvironmentFile=$CONFIG_DIR/local-data.env
ExecStart=$NODE_BIN $RUNTIME/backup-tencent-data.mjs
EOF

cat > /etc/systemd/system/cargo-pulse-data-backup.timer <<'EOF'
[Unit]
Description=Backup Cargo Pulse data every three days

[Timer]
OnBootSec=20m
OnUnitActiveSec=3d
Persistent=true

[Install]
WantedBy=timers.target
EOF

python3 - <<'PY'
from pathlib import Path
candidates=[]
for base in (Path('/etc/nginx/sites-available'),Path('/etc/nginx/conf.d')):
 if not base.exists(): continue
 for p in base.glob('*'):
  if not p.is_file(): continue
  try: s=p.read_text()
  except UnicodeDecodeError: continue
  if 'root /var/www/cargo-pulse' in s or 'location = /api/config {' in s: candidates.append((p,s))
if not candidates:
 p=Path('/etc/nginx/sites-available/default'); candidates=[(p,p.read_text())]
marker='    location = /api/config {'
block='''    location ~ ^/(auth/v1|rest/v1|storage/v1)/ {
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header Content-Type $content_type;
        client_max_body_size 100m;
}

'''
patched=0
for p,s in candidates:
 if marker not in s: continue
 # One file may contain separate HTTP and HTTPS server blocks. Remove the
 # generated block first, then insert it before every Cargo Pulse API marker.
 s=s.replace(block,'')
 p.write_text(s.replace(marker,block+marker))
 patched+=1
if not patched:
 raise SystemExit('未找到 Cargo Pulse 当前生效的 Nginx 配置')
PY

cat > /usr/local/sbin/cargo-pulse-activate-local-data <<'ACTIVATE'
#!/usr/bin/env bash
set -Eeuo pipefail
test "$(id -u)" -eq 0 || { echo '请使用 sudo 运行'; exit 1; }
read -r -p '主管登录邮箱: ' MIGRATION_EMAIL
read -r -s -p '主管登录密码: ' MIGRATION_PASSWORD
echo
export MIGRATION_EMAIL MIGRATION_PASSWORD
set -a
. /etc/cargo-pulse/local-data.env
set +a
export TENCENT_DATA_URL=http://127.0.0.1:8788
NODE_BIN="$(command -v node)"
if [ "$NODE_BIN" = /snap/bin/node ] && [ -x /snap/node/current/bin/node ]; then NODE_BIN=/snap/node/current/bin/node; fi
"$NODE_BIN" /opt/cargo-pulse-runtime/migrate-supabase-to-tencent.mjs
cp /etc/cargo-pulse/config.json "/etc/cargo-pulse/config.before-local-$(date +%Y%m%d%H%M%S).json"
printf '%s\n' '{"url":"same-origin","key":"local","backend":"tencent-v1"}' > /etc/cargo-pulse/config.json
install -m 644 -o www-data -g www-data /etc/cargo-pulse/config.json /var/www/cargo-pulse/api/config
systemctl restart cargo-pulse-images.service 2>/dev/null || true
echo '已切换腾讯云本地数据；等待旧页面自动完成手头操作。'
sleep 45
"$NODE_BIN" /opt/cargo-pulse-runtime/migrate-supabase-to-tencent.mjs
echo '第二次增量核对完成。Supabase 仅保留为登录迁移和回滚备份。'
ACTIVATE
chmod 750 /usr/local/sbin/cargo-pulse-activate-local-data

systemctl daemon-reload
systemctl enable --now cargo-pulse-data.service
systemctl enable --now cargo-pulse-data-backup.timer
nginx -t
systemctl reload nginx
healthy=''
for _ in {1..20}; do
  if curl -fsS http://127.0.0.1:8788/health; then healthy=1; break; fi
  sleep 0.5
done
if [ -z "$healthy" ]; then
  echo '腾讯云本地数据服务启动失败：' >&2
  systemctl status cargo-pulse-data.service --no-pager -l >&2 || true
  journalctl -u cargo-pulse-data.service -n 80 --no-pager >&2 || true
  exit 1
fi
echo
echo '本地数据服务已安装但尚未切换。确认空闲后运行：sudo cargo-pulse-activate-local-data'
