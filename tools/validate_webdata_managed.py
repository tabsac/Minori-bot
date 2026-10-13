#!/usr/bin/env python3
"""Validate public webdata bytes and every chart against published manifests."""
import argparse
import hashlib
import json
import pathlib
import re
import sys


def validate(root):
    root = pathlib.Path(root).resolve()
    version = json.loads((root / 'version.json').read_text(encoding='utf-8'))
    digests = version.get('fileDigests') or {}
    required = ['songs.json', 'cards.json', 'events.json', 'charts.json']
    for name in required:
        expected = digests.get(name, {}).get('sha256')
        if not expected or hashlib.sha256((root / name).read_bytes()).hexdigest() != expected:
            raise ValueError('Digest mismatch: ' + name)
    charts = json.loads((root / 'charts.json').read_text(encoding='utf-8'))
    files = charts.get('files') or {}
    expected_count = (version.get('counts') or {}).get('charts')
    if charts.get('missing') or (version.get('charts') or {}).get('missing'):
        raise ValueError('Missing charts listed in manifest')
    if expected_count != len(files) or charts.get('count') != len(files):
        raise ValueError('Chart counts do not agree')
    actual = {p.name for p in (root / 'charts').glob('*.json')}
    if actual != set(files):
        raise ValueError('Chart filenames differ from manifest')
    total_bytes = 0
    for name, metadata in files.items():
        if not re.match(r'^\d{3,8}_(EASY|NORMAL|HARD|EXPERT)\.json$', name):
            raise ValueError('Invalid chart filename')
        content = (root / 'charts' / name).read_bytes()
        if hashlib.sha256(content).hexdigest() != metadata.get('sha256') or len(content) != metadata.get('bytes'):
            raise ValueError('Chart bytes mismatch: ' + name)
        json.loads(content.decode('utf-8'))
        total_bytes += len(content)
    return {'status': 'ok', 'files_checked': len(required), 'charts_checked': len(files), 'chart_bytes': total_bytes}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(validate(args.root)))
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(json.dumps({'status': 'failed', 'reason': str(error)}))
        sys.exit(1)
