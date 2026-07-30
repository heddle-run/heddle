#!/usr/bin/env bash
set -euo pipefail
INPUT=$(cat)

python3 -c "
import json, sys, os

data = json.load(sys.stdin)
plan = data.get('plan', '')
workdir = data.get('working_directory', '.')

if not plan:
    json.dump({'result': 'Error: no plan content provided'}, sys.stdout)
    sys.exit(0)

try:
    plan_path = os.path.join(workdir, '.plan.md')
    with open(plan_path, 'w') as f:
        f.write(plan)
    json.dump({'result': f'Plan written to {plan_path}'}, sys.stdout)
except Exception as e:
    json.dump({'result': f'Error: {e}'}, sys.stdout)
" <<< "$INPUT"
