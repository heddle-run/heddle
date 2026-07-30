#!/usr/bin/env bash
set -euo pipefail
INPUT=$(cat)

python3 -c "
import json, sys, os

data = json.load(sys.stdin)
path = data.get('path', '')
content = data.get('content', '')

if not path:
    json.dump({'result': 'Error: no path provided'}, sys.stdout)
    sys.exit(0)

try:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, 'w') as f:
        f.write(content)
    json.dump({'result': f'Successfully wrote {len(content)} bytes to {path}'}, sys.stdout)
except Exception as e:
    json.dump({'result': f'Error: {e}'}, sys.stdout)
" <<< "$INPUT"
