#!/usr/bin/env python3
"""Read-only affected formatting/lint checks; never installs tools or edits source."""
import argparse
from pathlib import Path
import os
import subprocess
import sys

from select_affected_tests import changed_files

ROOT = Path(__file__).resolve().parents[1]
EXTENSIONS = {'.ts', '.tsx'}  # Preserve /deploy's existing formatting scope.


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind', choices=['format', 'lint'])
    args = parser.parse_args()
    changed = changed_files(os.environ.get('DEPLOY_BASE_REF', 'origin/main'), None)
    if args.kind == 'lint':
        backend = ROOT / 'back-end'
        files = [path.removeprefix('back-end/') for path in changed
                 if path.startswith('back-end/src/') and path.endswith(('.ts', '.tsx'))
                 and (ROOT / path).is_file()]
        if any(path.startswith('back-end/') and any(key in path for key in
               ('package', 'tsconfig', 'eslint')) for path in changed):
            files = [str(path.relative_to(backend)) for path in (backend / 'src').rglob('*')
                     if path.is_file() and path.suffix in {'.ts', '.tsx'}]
        if not files:
            print('LINT: no affected backend sources')
            return 0
        return subprocess.run(['node', 'scripts/lint-affected.mjs', *sorted(files)], cwd=backend).returncode
    files = [path for path in changed
             if (ROOT / path).is_file() and Path(path).suffix in EXTENSIONS]
    if not files:
        print('FORMAT: no changed supported files')
        return 0
    binary = next((p for p in [ROOT/'node_modules/.bin/prettier', ROOT/'back-end/node_modules/.bin/prettier']
                   if p.is_file()), None)
    if binary is None:
        print('FORMAT: installed repository Prettier required; install pinned dependencies first', file=sys.stderr)
        return 2
    return subprocess.run([str(binary), '--check', '--ignore-unknown', '--', *files], cwd=ROOT).returncode


if __name__ == '__main__':
    raise SystemExit(main())
