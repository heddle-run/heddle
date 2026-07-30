#!/usr/bin/env bash
set -euo pipefail
INPUT=$(cat)

python3 -c "
import json, sys

data = json.load(sys.stdin)
path = data.get('path', '')

if not path:
    json.dump({'content': 'Error: no path provided'}, sys.stdout)
    sys.exit(0)

try:
    with open(path, 'r') as f:
        content = f.read()
    json.dump({'content': content}, sys.stdout)
except FileNotFoundError:
    json.dump({'content': f'Error: file not found: {path}'}, sys.stdout)
except PermissionError:
    json.dump({'content': f'Error: permission denied: {path}'}, sys.stdout)
except Exception as e:
    json.dump({'content': f'Error reading file: {e}'}, sys.stdout)
" <<< "$INPUT"
