#!/usr/bin/env bash
set -Eeuo pipefail

test "$(id -u)" -eq 0 || { echo '请使用 sudo bash 运行'; exit 1; }

NGINX_CONF=/etc/nginx/nginx.conf
BACKUP="/etc/nginx/nginx.conf.before-cargo-mobile-$(date +%Y%m%d%H%M%S)"
cp "$NGINX_CONF" "$BACKUP"
rm -f /etc/nginx/conf.d/cargo-pulse-compression.conf /etc/nginx/conf.d/cargo-pulse-fresh-assets.conf

python3 - <<'PY'
from pathlib import Path
import re

p=Path('/etc/nginx/nginx.conf')
s=p.read_text()
directives='''\n\tgzip on;
\tgzip_vary on;
\tgzip_comp_level 5;
\tgzip_min_length 256;
\tgzip_types text/css application/javascript application/json image/svg+xml;\n'''
s=re.sub(r'^\s*gzip(?:_vary|_comp_level|_min_length|_types)?\s+[^;]+;\s*$', '', s, flags=re.M)
marker=re.search(r'^\s*include\s+/etc/nginx/conf\.d/\*\.conf;\s*$',s,flags=re.M)
if not marker:
    raise SystemExit('nginx.conf 中未找到 conf.d 引入位置')
s=s[:marker.start()]+directives+s[marker.start():]
p.write_text(s)
PY

cat > /etc/nginx/conf.d/cargo-pulse-browser-cache.conf <<'NGINX'
map $sent_http_content_type $cargo_pulse_expires {
    default off;
    text/css 365d;
    application/javascript 365d;
}
expires $cargo_pulse_expires;
NGINX

if ! nginx -t; then
  cp "$BACKUP" "$NGINX_CONF"
  rm -f /etc/nginx/conf.d/cargo-pulse-browser-cache.conf
  nginx -t
  echo '配置验证失败，已自动恢复原配置。' >&2
  exit 1
fi

systemctl reload nginx
ASSET="$(find /var/www/cargo-pulse/assets -maxdepth 1 -type f -name '*.js' -printf '%f\n' | head -n 1)"
HEADERS="$(curl -fsSI -H 'Accept-Encoding: gzip' "http://127.0.0.1/assets/$ASSET")"
echo "$HEADERS" | grep -Ei 'HTTP/|content-encoding|content-length|cache-control|expires'
echo "$HEADERS" | grep -Eqi '^Content-Encoding:\s*gzip' || { echo '压缩验证失败' >&2; exit 1; }
echo "$HEADERS" | grep -Eqi '^Cache-Control:.*max-age' || { echo '缓存验证失败' >&2; exit 1; }
echo '手机端静态资源压缩与缓存已经生效。'
