#!/usr/bin/env python3
"""Quick checks preserve the existing affected TypeScript formatting contract."""
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


if __name__=='__main__':unittest.main()
