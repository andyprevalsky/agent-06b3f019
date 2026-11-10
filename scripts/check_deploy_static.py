#!/usr/bin/env python3
"""Read-only affected formatting/lint checks; never installs tools or edits source."""
import argparse
from pathlib import Path
import json
import re
import subprocess
import sys

from select_affected_tests import changed_files

ROOT = Path(__file__).resolve().parents[1]
EXTENSIONS = {'.ts', '.tsx'}  # Preserve /deploy's existing formatting scope.


def package_prettier_changed(path: str, base: str) -> bool:
    revision = subprocess.check_output(['git', 'merge-base', base, 'HEAD'], cwd=ROOT, text=True).strip()
    previous = subprocess.run(['git', 'show', f'{revision}:{path}'], cwd=ROOT,
                              capture_output=True, text=True)
    before = json.loads(previous.stdout) if previous.returncode == 0 else {}
    current = ROOT / path
    after = json.loads(current.read_text()) if current.is_file() else {}
    return before.get('prettier') != after.get('prettier')


def format_files(changed: list[str], base: str) -> list[str]:
    files = {path for path in changed if (ROOT / path).is_file() and Path(path).suffix in EXTENSIONS}
    scopes = set()
    for path in changed:
        name = Path(path).name
        if (name in {'.prettierrc', '.prettierignore'} or name.startswith(('.prettierrc.', 'prettier.config.'))
                or name == '.editorconfig'
                or (name == 'package.json' and package_prettier_changed(path, base))):
            scopes.add(str(Path(path).parent))
    for scope in sorted(scopes):
        output = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others',
                                          '--exclude-standard', '--', scope], cwd=ROOT)
        files.update(path for raw in output.split(b'\0') if raw
                     for path in [raw.decode()] if Path(path).suffix in EXTENSIONS and (ROOT / path).is_file())
    return sorted(files)


# Original /deploy CHANGED_BACKEND_LINT_INPUTS (deploy.md L500-506): root or back-end manifests and
# lockfiles, back-end tsconfig*/eslint.config.* and the Prisma schema lint the whole back-end/src tree.
BACKEND_LINT_INPUTS = re.compile(
    r'^(package(-lock)?\.json|back-end/(package(-lock)?\.json|tsconfig[^/]*\.json'
    r'|eslint\.config\.(mjs|js|cjs|ts)|prisma/schema\.prisma))$')


def lint_files(changed: list[str]) -> list[str]:
    """Back-end-relative sources to lint; a backend lint input change lints all of src."""
    backend = ROOT / 'back-end'
    files = [path.removeprefix('back-end/') for path in changed
             if path.startswith('back-end/src/') and path.endswith(('.ts', '.tsx'))
             and (ROOT / path).is_file()]
    if any(BACKEND_LINT_INPUTS.match(path) for path in changed):
        files = [str(path.relative_to(backend)) for path in (backend / 'src').rglob('*')
                 if path.is_file() and path.suffix in {'.ts', '.tsx'}]
    return sorted(files)


def prettier_binary() -> Path | None:
    return next((p for p in [ROOT/'node_modules/.bin/prettier', ROOT/'back-end/node_modules/.bin/prettier']
                 if p.is_file()), None)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind', choices=['format', 'lint'])
    parser.add_argument('--base', default='origin/main')
    args = parser.parse_args()
    changed = changed_files(args.base, None)
    if args.kind == 'lint':
        files = lint_files(changed)
        if not files:
            print('LINT: no affected backend sources')
            return 0
        return subprocess.run(['node', 'scripts/lint-affected.mjs', *files], cwd=ROOT / 'back-end').returncode
    files = format_files(changed, args.base)
    if not files:
        print('FORMAT: no changed supported files')
        return 0
    binary = prettier_binary()
    if binary is None:
        print('FORMAT: installed repository Prettier required; install pinned dependencies first', file=sys.stderr)
        return 2
    return subprocess.run([str(binary), '--check', '--ignore-unknown', '--', *files], cwd=ROOT).returncode


if __name__ == '__main__':
    raise SystemExit(main())
