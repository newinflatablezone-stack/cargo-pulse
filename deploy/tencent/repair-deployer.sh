#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOYER_URL="https://raw.githubusercontent.com/newinflatablezone-stack/cargo-pulse/main/deploy/tencent/cargo-pulse-deploy"
TMP_DEPLOYER="$(mktemp /tmp/cargo-pulse-deploy.XXXXXX)"
trap 'rm -f -- "$TMP_DEPLOYER"' EXIT

curl -fsSL -H 'Cache-Control: no-cache' "${DEPLOYER_URL}?v=$(date +%s)" -o "$TMP_DEPLOYER"
install -m 755 "$TMP_DEPLOYER" /usr/local/bin/cargo-pulse-deploy

systemctl stop cargo-pulse-deploy.timer 2>/dev/null || true
systemctl reset-failed cargo-pulse-deploy.service 2>/dev/null || true
if ! systemctl start cargo-pulse-deploy.service; then
  echo
  echo "部署失败，以下是真实错误："
  journalctl -u cargo-pulse-deploy.service -n 100 --no-pager
  exit 1
fi

systemctl enable --now cargo-pulse-deploy.timer
systemctl status cargo-pulse-deploy.service --no-pager || true
echo "自动部署器已彻底修复。"
