#!/usr/bin/env bash
set -euo pipefail

APP_USER="ubuntu"
APP_SOURCE="/opt/cargo-pulse"
APP_ROOT="/var/www/cargo-pulse"
APP_CONFIG="/etc/cargo-pulse/config.json"

cat > /usr/local/bin/cargo-pulse-deploy <<'DEPLOY'
#!/usr/bin/env bash
set -euo pipefail
exec 9>/run/lock/cargo-pulse-deploy.lock
flock -n 9 || exit 0

APP_USER="ubuntu"
APP_SOURCE="/opt/cargo-pulse"
APP_ROOT="/var/www/cargo-pulse"
APP_CONFIG="/etc/cargo-pulse/config.json"

# Keep the source tree owned by the account that runs Git, npm and Vite.
chown -R "$APP_USER:$APP_USER" "$APP_SOURCE"
git config --system --add safe.directory "$APP_SOURCE" 2>/dev/null || true
sudo -u "$APP_USER" git config --global --add safe.directory "$APP_SOURCE" 2>/dev/null || true

sudo -u "$APP_USER" git -C "$APP_SOURCE" fetch origin main
if [ -f "$APP_SOURCE/package-lock.json" ] && ! sudo -u "$APP_USER" git -C "$APP_SOURCE" ls-files --error-unmatch package-lock.json >/dev/null 2>&1; then
  rm -f "$APP_SOURCE/package-lock.json"
fi
sudo -u "$APP_USER" git -C "$APP_SOURCE" checkout main
sudo -u "$APP_USER" git -C "$APP_SOURCE" pull --ff-only origin main

if [ -f "$APP_SOURCE/package-lock.json" ] || [ -f "$APP_SOURCE/npm-shrinkwrap.json" ]; then
  sudo -u "$APP_USER" bash -lc "cd '$APP_SOURCE' && npm ci --no-audit --no-fund"
else
  sudo -u "$APP_USER" bash -lc "cd '$APP_SOURCE' && npm install --no-audit --no-fund"
fi

# Never let files written by a previous root deployment block the next build.
rm -rf "$APP_SOURCE/dist"
sudo -u "$APP_USER" bash -lc "cd '$APP_SOURCE' && npm run build"

install -d -o "$APP_USER" -g "$APP_USER" "$APP_SOURCE/dist/api"
install -m 644 -o "$APP_USER" -g "$APP_USER" "$APP_CONFIG" "$APP_SOURCE/dist/api/config"
VERSION="$(sudo -u "$APP_USER" git -C "$APP_SOURCE" rev-parse HEAD)"
printf '{"version":"%s"}\n' "$VERSION" > "$APP_SOURCE/dist/api/version"
chown -R "$APP_USER:$APP_USER" "$APP_SOURCE/dist"

install -d "$APP_ROOT"
rsync -a --delete "$APP_SOURCE/dist/" "$APP_ROOT/"
chown -R www-data:www-data "$APP_ROOT"
nginx -t
systemctl reload nginx
DEPLOY

chmod 755 /usr/local/bin/cargo-pulse-deploy
chown -R "$APP_USER:$APP_USER" "$APP_SOURCE"
git config --system --add safe.directory "$APP_SOURCE" 2>/dev/null || true
sudo -u "$APP_USER" git config --global --add safe.directory "$APP_SOURCE" 2>/dev/null || true
systemctl reset-failed cargo-pulse-deploy.service || true
systemctl start cargo-pulse-deploy.service
systemctl status cargo-pulse-deploy.service --no-pager
