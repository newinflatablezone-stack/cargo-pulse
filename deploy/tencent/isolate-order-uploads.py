#!/usr/bin/env python3
"""Remove the public static bypass for private order attachments."""
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

def prepare_patches(root):
    paths = set()
    for folder in ('sites-enabled', 'conf.d'):
        directory = Path(root) / folder
        if directory.exists():
            paths.update(path.resolve() for path in directory.iterdir() if path.is_file())
    patches = {}
    for path in sorted(paths):
        text = path.read_text()
        if '/var/lib/cargo-pulse/uploads/' not in text:
            continue
        base = text.replace(GUARD, '')
        if re.search(r'location\s+(?:(?:\^~|=)\s+)?/uploads/orders/?\s*\{', base):
            raise RuntimeError(f'Existing manual order-upload location requires review: {path}')
        updated, count = re.subn(r'(?m)^[ \t]*location\s+(?:\^~\s+)?/uploads/\s*\{', lambda match: GUARD + match.group(), base)
        if count and updated != text:
            patches[path] = (text, updated)
    if not patches and any('/var/lib/cargo-pulse/uploads/' in path.read_text() for path in paths) and not any('cargo-pulse-private-order-uploads' in path.read_text() for path in paths):
        raise RuntimeError('No active Cargo Pulse upload location was found')
    return patches

def main():
    if os.geteuid() != 0:
        raise SystemExit('Please run with sudo python3')
    patches = prepare_patches('/etc/nginx')
    if not patches:
        print('No public order-upload configuration changes required')
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
    print('Private order-upload static routes blocked. Backup:', backup)

if __name__ == '__main__':
    main()
