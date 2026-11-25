#!/usr/bin/env python3
"""Maintain the Nginx protections deployed with Cargo Pulse."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

GUARD = '''    # cargo-pulse-private-order-uploads
    location ^~ /uploads/orders/ {
        add_header X-Cargo-Pulse-Order-Privacy "scoped" always;
        add_header Cache-Control "private, no-store" always;
        return 404;
    }
    location = /uploads/orders {
        add_header X-Cargo-Pulse-Order-Privacy "scoped" always;
        return 404;
    }

'''

PROXY_CLIENT_IP = '        proxy_set_header X-Cargo-Client-IP $remote_addr;\n'
HTML_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
}


def harden_site(text):
    def update_server(server):
        block = server.group()

        def set_client_ip(proxy):
            prefix = block[:proxy.start()]
            if re.search(r'(?im)^\s*proxy_set_header\s+X-Cargo-Client-IP\s+\$remote_addr\s*;\s*$', prefix.rsplit('{', 1)[-1]):
                return proxy.group()
            return PROXY_CLIENT_IP + proxy.group()

        block = re.sub(r'(?m)^[ \t]*proxy_pass\s+http://127\.0\.0\.1:8788\s*;', set_client_ip, block)
        if not re.search(r'^\s*root\s+/var/www/cargo-pulse\s*;', block, re.M):
            return block

        def add_headers(location):
            section = location.group()
            # Cargo Pulse locations already declare Cache-Control. Limit edits to
            # those blocks so introducing add_header cannot mask inherited headers.
            if not re.search(r'\badd_header\s+Cache-Control\b', section, re.I):
                return section
            additions = ''.join(f'        add_header {name} "{value}" always;\n'
                                for name, value in HTML_HEADERS.items()
                                if not re.search(r'\badd_header\s+' + re.escape(name) + r'\s', section, re.I))
            return section.replace('\n', '\n' + additions, 1)

        return re.sub(r'(?m)^[ \t]*location(?:\s+=\s+/index\.html|\s+/)\s*\{[^{}]*\}', add_headers, block)

    return re.sub(r'(?ms)^[ \t]*server[ \t]*\{.*?(?=^[ \t]*server[ \t]*\{|\Z)', update_server, text)

def prepare_patches(root):
    paths = set()
    for folder in ('sites-enabled', 'conf.d'):
        directory = Path(root) / folder
        if directory.exists():
            paths.update(path.resolve() for path in directory.iterdir() if path.is_file())
    patches = {}
    for path in sorted(paths):
        text = path.read_text()
        updated = text
        if '/var/lib/cargo-pulse/uploads/' in text:
            base = text.replace(GUARD, '')
            if re.search(r'location\s+(?:(?:\^~|=)\s+)?/uploads/orders/?\s*\{', base):
                raise RuntimeError(f'Existing manual order-upload location requires review: {path}')
            updated = re.sub(r'(?m)^[ \t]*location\s+(?:\^~\s+)?/uploads/\s*\{', lambda match: GUARD + match.group(), base)
        updated = harden_site(updated)
        if updated != text:
            patches[path] = (text, updated)
    if not patches and any('/var/lib/cargo-pulse/uploads/' in path.read_text() for path in paths) and not any('cargo-pulse-private-order-uploads' in path.read_text() for path in paths):
        raise RuntimeError('No active Cargo Pulse upload location was found')
    return patches

def main():
    if os.geteuid() != 0:
        raise SystemExit('Please run with sudo python3')
    patches = prepare_patches('/etc/nginx')
    if not patches:
        print('No Cargo Pulse Nginx changes required')
        return
    backup = Path(tempfile.mkdtemp(prefix='cargo-order-privacy-backup-'))
    manifest = {}
    for index, (path, (before, after)) in enumerate(patches.items()):
        name = f'{index}.conf'
        (backup / name).write_text(before)
        manifest[str(path)] = name
    (backup / 'manifest.json').write_text(json.dumps(manifest))
    try:
        for path, (before, after) in patches.items():
            path.write_text(after)
        subprocess.run(['nginx', '-t'], check=True)
        subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    except Exception:
        for path, (before, after) in patches.items():
            path.write_text(before)
        raise
    print('Cargo Pulse Nginx protections applied. Backup:', backup)

if __name__ == '__main__':
    main()
