#!/usr/bin/env python3
"""Quick checks preserve the existing affected TypeScript formatting contract."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import check_deploy_static as quick


class Quick(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.mock=patch.object(quick,'ROOT',self.root);self.mock.start()

    def tearDown(self):
        self.mock.stop();self.temp.cleanup()

    def write(self,path):
        file=self.root/path;file.parent.mkdir(parents=True,exist_ok=True);file.write_text('x')

    def invoke(self,kind,changed):
        with patch.object(sys,'argv',['check',kind]), patch.object(quick,'changed_files',return_value=changed):
            return quick.main()

    def test_docs_do_not_expand_existing_format_scope(self):
        self.write('README.md');self.write('settings.json')
        with patch.object(quick.subprocess,'run') as execute:
            self.assertEqual(0,self.invoke('format',['README.md','settings.json']))
            execute.assert_not_called()

    def test_format_uses_exact_ts_paths_and_keeps_tool_failure(self):
        self.write('back-end/node_modules/.bin/prettier');self.write('back-end/src/a.ts')
        with patch.object(quick.subprocess,'run',return_value=subprocess.CompletedProcess([],1)) as execute:
            self.assertEqual(1,self.invoke('format',['back-end/src/a.ts','removed.ts']))
            self.assertEqual('back-end/src/a.ts',execute.call_args.args[0][-1])
            self.assertNotIn('removed.ts',execute.call_args.args[0])

    def test_lint_passes_changes_to_existing_reverse_importer_checker(self):
        self.write('back-end/src/a.ts')
        with patch.object(quick.subprocess,'run',return_value=subprocess.CompletedProcess([],0)) as execute:
            self.assertEqual(0,self.invoke('lint',['back-end/src/a.ts']))
            self.assertEqual(['node','scripts/lint-affected.mjs','src/a.ts'],execute.call_args.args[0])

    def test_shared_ts_config_lints_all_backend_sources(self):
        self.write('back-end/src/a.ts');self.write('back-end/src/b.tsx')
        with patch.object(quick.subprocess,'run',return_value=subprocess.CompletedProcess([],0)) as execute:
            self.assertEqual(0,self.invoke('lint',['back-end/tsconfig.json']))
            self.assertEqual({'src/a.ts','src/b.tsx'},set(execute.call_args.args[0][2:]))

    def prepare(self, config, package=None):
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        self.write('.gitignore'); (self.root / '.gitignore').write_text('**/node_modules/\nselected.json\n')
        for path in ('back-end/src/a.ts', 'back-end/src/deep/b.tsx', 'back-end-extra/c.ts', 'front-end/d.ts'):
            self.write(path)
        file = self.root / config; file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps(package) if package is not None else '{}')
        subprocess.run(['git', 'add', '.'], cwd=self.root, check=True)
        subprocess.run(['git', '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'base'],
                       cwd=self.root, check=True)
        subprocess.run(['git', 'update-ref', 'refs/remotes/origin/main', 'HEAD'], cwd=self.root, check=True)
        self.write('back-end/node_modules/ignored.ts')
        binary = self.root / 'node_modules/.bin/prettier'; binary.parent.mkdir(parents=True)
        binary.write_text('#!' + sys.executable + '\nimport json,sys\nfrom pathlib import Path\n'
                          + 'Path("selected.json").write_text(json.dumps(sys.argv[1:]))\nraise SystemExit(7)\n')
        binary.chmod(0o700)
        return file

    def selected(self):
        return json.loads((self.root / 'selected.json').read_text())[3:]

    def test_config_change_checks_complete_subtree_and_preserves_failure(self):
        config = self.prepare('back-end/.prettierrc')
        config.write_text('{"semi": false}')
        self.assertEqual(7, self.invoke('format', ['back-end/.prettierrc']))
        self.assertEqual(['back-end/src/a.ts', 'back-end/src/deep/b.tsx'], self.selected())

    def test_deleted_root_config_checks_every_governed_ts_and_tsx(self):
        config = self.prepare('.prettierrc'); config.unlink()
        self.assertEqual(7, self.invoke('format', ['.prettierrc']))
        self.assertEqual({'back-end/src/a.ts', 'back-end/src/deep/b.tsx',
                          'back-end-extra/c.ts', 'front-end/d.ts'}, set(self.selected()))

    def test_removed_package_prettier_setting_still_checks_complete_subtree(self):
        config = self.prepare('back-end/package.json', {'prettier': {'semi': True}, 'version': '1'})
        config.write_text('{"version": "2"}')
        self.assertEqual(7, self.invoke('format', ['back-end/package.json']))
        self.assertEqual(['back-end/src/a.ts', 'back-end/src/deep/b.tsx'], self.selected())

    def test_unignore_only_change_checks_complete_governed_inventory(self):
        import select_affected_tests as selector
        config = self.prepare('.prettierignore')
        config.write_text('**/*.ts\n**/*.tsx\n')
        subprocess.run(['git', 'add', '.prettierignore'], cwd=self.root, check=True)
        subprocess.run(['git', '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'ignore'],
                       cwd=self.root, check=True)
        subprocess.run(['git', 'update-ref', 'refs/remotes/origin/main', 'HEAD'], cwd=self.root, check=True)
        config.write_text('')
        with patch.object(selector, 'ROOT', self.root), patch.object(sys, 'argv', ['check', 'format']):
            self.assertEqual(['.prettierignore'], selector.changed_files('origin/main', None))
            self.assertEqual(7, quick.main())
        self.assertEqual({'back-end/src/a.ts', 'back-end/src/deep/b.tsx',
                          'back-end-extra/c.ts', 'front-end/d.ts'}, set(self.selected()))

    def test_unrelated_package_change_does_not_expand_format_scope(self):
        config = self.prepare('back-end/package.json', {'prettier': {'semi': True}, 'version': '1'})
        config.write_text('{"prettier": {"semi": true}, "version": "2"}')
        self.assertEqual(0, self.invoke('format', ['back-end/package.json']))
        self.assertFalse((self.root / 'selected.json').exists())


if __name__=='__main__':unittest.main()
