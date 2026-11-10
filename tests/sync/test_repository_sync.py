import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

CLI = Path(__file__).resolve().parents[2] / 'scripts/sync-ai-pilot.py'


def git(repo, *args):
    result = subprocess.run(['git', '-C', str(repo), *args], text=True, capture_output=True, check=True)
    return result.stdout.strip()


def write_commit(repo, path, content, message):
    target = repo / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)
    git(repo, 'add', path)
    git(repo, 'commit', '-m', message)
    return git(repo, 'rev-parse', 'HEAD')


class Synchronization(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / 'source'
        self.team = self.root / 'team'
        for repo in [self.source, self.team]:
            repo.mkdir()
            git(repo, 'init', '-b', 'main')
            git(repo, 'config', 'user.name', 'Sync Test')
            git(repo, 'config', 'user.email', 'sync-test@example.invalid')
        self.source_base = write_commit(self.source, 'src/a.txt', 'base', 'source base')
        write_commit(self.team, 'README.md', 'team root', 'team root')
        self.team_base = write_commit(self.team, 'mcp/ai-pilot/src/a.txt', 'base', 'team base')

    def tearDown(self):
        self.temp.cleanup()

    def command(self, operation, source=None, team=None, extra=(), expected=0):
        args = [sys.executable, str(CLI), operation, '--source', str(source or self.source), '--team', str(team or self.team), *extra]
        result = subprocess.run(args, text=True, capture_output=True)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def bootstrap(self, extra=(), expected=0):
        return self.command('bootstrap', extra=('--source-base', self.source_base, '--team-base', self.team_base, '--workspace', str(self.root / 'bootstrap'), '--apply', *extra), expected=expected)

    def test_preview_changes_nothing_and_reports_local_tree_difference(self):
        write_commit(self.source, 'src/local.txt', 'personal', 'personal change')
        before = [git(repo, 'rev-parse', 'HEAD') for repo in [self.source, self.team]]
        result = self.command('export')
        self.assertEqual(result['status'], 'preview')
        self.assertFalse(result['treesEqual'])
        self.assertEqual(before, [git(repo, 'rev-parse', 'HEAD') for repo in [self.source, self.team]])
        self.assertFalse((self.root / 'bootstrap').exists())

    def test_bootstrap_merges_both_histories_and_records_source_revisions(self):
        personal = write_commit(self.source, 'src/local.txt', 'personal', 'personal change')
        team = write_commit(self.team, 'mcp/ai-pilot/src/team.txt', 'colleague', 'team change')
        result = self.bootstrap()
        merged = Path(result['result']['repo'])
        self.assertEqual(result['status'], 'ready')
        self.assertEqual((merged / 'src/local.txt').read_text(), 'personal')
        self.assertEqual((merged / 'src/team.txt').read_text(), 'colleague')
        self.assertEqual(result['sourceCommit'], personal)
        self.assertEqual(result['teamCommit'], team)
        self.assertEqual(git(self.source, 'rev-parse', 'HEAD'), personal)
        self.assertEqual(git(self.team, 'rev-parse', 'HEAD'), team)
        self.assertEqual(git(merged, 'merge-base', '--is-ancestor', personal, 'HEAD'), '')

    def test_export_preserves_team_files_and_then_imports_colleague_updates(self):
        result = self.bootstrap()
        source = Path(result['result']['repo'])
        write_commit(source, 'src/a.txt', 'personal new', 'personal update')
        write_commit(self.team, 'mcp/ai-pilot/src/team.txt', 'team new', 'colleague update')
        exported = self.command('export', source=source, extra=('--workspace', str(self.root / 'export'), '--apply'))
        team = Path(exported['result']['repo'])
        self.assertEqual((team / 'README.md').read_text(), 'team root')
        self.assertEqual((team / 'mcp/ai-pilot/src/a.txt').read_text(), 'personal new')
        self.assertEqual((team / 'mcp/ai-pilot/src/team.txt').read_text(), 'team new')
        imported = self.command('import', source=source, team=team, extra=('--workspace', str(self.root / 'import'), '--apply'))
        merged = Path(imported['result']['repo'])
        self.assertEqual((merged / 'src/team.txt').read_text(), 'team new')
        status = self.command('status', source=merged, team=team, extra=('--require-equal',))
        self.assertTrue(status['treesEqual'])

    def test_conflict_is_reviewable_and_continue_finishes_without_touching_originals(self):
        write_commit(self.source, 'src/a.txt', 'personal change', 'personal conflicting change')
        write_commit(self.team, 'mcp/ai-pilot/src/a.txt', 'team change', 'team conflicting change')
        source_tip = git(self.source, 'rev-parse', 'HEAD')
        team_tip = git(self.team, 'rev-parse', 'HEAD')
        result = self.bootstrap(expected=2)
        self.assertEqual(result['status'], 'conflict')
        clone = Path(result['result']['repo'])
        self.assertIn('src/a.txt', result['conflicts'])
        (clone / 'src/a.txt').write_text('reviewed combination')
        git(clone, 'add', 'src/a.txt')
        continued = self.command('continue', extra=('--workspace', str(self.root / 'bootstrap'), '--apply'))
        self.assertEqual(continued['status'], 'ready')
        self.assertEqual((clone / 'src/a.txt').read_text(), 'reviewed combination')
        self.assertEqual(git(self.source, 'rev-parse', 'HEAD'), source_tip)
        self.assertEqual(git(self.team, 'rev-parse', 'HEAD'), team_tip)

    def test_dirty_sources_and_unrelated_histories_require_explicit_resolution(self):
        (self.source / 'src/a.txt').write_text('uncommitted')
        result = self.command('export', extra=('--apply', '--workspace', str(self.root / 'dirty')), expected=1)
        self.assertIn('uncommitted', result['error'])
        self.assertFalse((self.root / 'dirty').exists())
        git(self.source, 'restore', 'src/a.txt')
        result = self.command('import', extra=('--apply', '--workspace', str(self.root / 'unrelated')), expected=1)
        self.assertIn('bootstrap', result['error'])

    def test_ci_gate_fails_when_committed_trees_differ(self):
        write_commit(self.team, 'mcp/ai-pilot/extra.txt', 'team', 'extra')
        result = self.command('status', extra=('--require-equal',), expected=1)
        self.assertFalse(result['treesEqual'])

    def test_invalid_prefix_is_rejected_before_operations(self):
        result = self.command('export', extra=('--prefix', '../other', '--apply'), expected=1)
        self.assertIn('prefix', result['error'])

    def test_export_conflict_can_continue_and_retains_team_root(self):
        source = Path(self.bootstrap()['result']['repo'])
        write_commit(source, 'src/a.txt', 'personal', 'personal edit')
        write_commit(self.team, 'mcp/ai-pilot/src/a.txt', 'team', 'team edit')
        workspace = self.root / 'export-conflict'
        result = self.command('export', source=source, extra=('--workspace', str(workspace), '--apply'), expected=2)
        clone = Path(result['result']['repo'])
        self.assertIn('mcp/ai-pilot/src/a.txt', result['conflicts'])
        unresolved = self.command('continue', extra=('--workspace', str(workspace), '--apply'), expected=2)
        self.assertEqual(unresolved['status'], 'conflict')
        (clone / 'mcp/ai-pilot/src/a.txt').write_text('combined')
        git(clone, 'add', 'mcp/ai-pilot/src/a.txt')
        result = self.command('continue', extra=('--workspace', str(workspace), '--apply'))
        self.assertEqual(result['status'], 'ready')
        self.assertEqual((clone / 'README.md').read_text(), 'team root')
        self.assertTrue(result['needsFollowupImport'])

    def test_continuation_rejects_resolutions_changing_team_root(self):
        source = Path(self.bootstrap()['result']['repo'])
        write_commit(source, 'src/a.txt', 'personal', 'personal edit')
        write_commit(self.team, 'mcp/ai-pilot/src/a.txt', 'team', 'team edit')
        workspace = self.root / 'export-bad-resolution'
        result = self.command('export', source=source, extra=('--workspace', str(workspace), '--apply'), expected=2)
        clone = Path(result['result']['repo'])
        (clone / 'mcp/ai-pilot/src/a.txt').write_text('combined')
        (clone / 'README.md').write_text('unexpected change')
        git(clone, 'add', '.')
        result = self.command('continue', extra=('--workspace', str(workspace), '--apply'), expected=1)
        self.assertIn('outside', result['error'])

    def test_repeated_round_trip_retains_ancestry(self):
        source = Path(self.bootstrap()['result']['repo'])
        team = self.team
        for index in range(2):
            write_commit(source, f'src/personal-{index}.txt', 'personal', 'personal addition')
            write_commit(team, f'mcp/ai-pilot/src/team-{index}.txt', 'team', 'team addition')
            result = self.command('export', source=source, team=team, extra=('--workspace', str(self.root / f'export-{index}'), '--apply'))
            team = Path(result['result']['repo'])
            result = self.command('import', source=source, team=team, extra=('--workspace', str(self.root / f'import-{index}'), '--apply'))
            source = Path(result['result']['repo'])
        self.assertTrue(self.command('status', source=source, team=team, extra=('--require-equal',))['treesEqual'])
        equal_export = self.command('export', source=source, team=team, extra=('--workspace', str(self.root / 'no-op'), '--apply'))
        self.assertTrue(equal_export['treesEqual'])
        self.assertFalse(equal_export['needsFollowupImport'])

    def test_preview_and_apply_exclude_ignored_uncommitted_files(self):
        write_commit(self.source, '.gitignore', 'private.txt\n', 'ignore private config')
        (self.source / 'private.txt').write_text('local-only')
        result = self.bootstrap()
        self.assertFalse((Path(result['result']['repo']) / 'private.txt').exists())
        self.assertFalse(result['sourceDirty'])

    def test_dirty_team_and_nested_workspace_are_rejected(self):
        (self.team / 'README.md').write_text('uncommitted team')
        result = self.command('export', extra=('--apply', '--workspace', str(self.root / 'dirty-team')), expected=1)
        self.assertIn('uncommitted', result['error'])
        git(self.team, 'restore', 'README.md')
        result = self.command('export', extra=('--apply', '--workspace', str(self.source / 'scratch')), expected=1)
        self.assertIn('separate', result['error'])
        self.assertFalse((self.source / 'scratch').exists())

    def test_continue_refuses_replaced_history_after_aborted_merge(self):
        write_commit(self.source, 'src/personal.txt', 'personal', 'personal file')
        write_commit(self.source, 'src/a.txt', 'personal edit', 'personal conflict')
        write_commit(self.team, 'mcp/ai-pilot/src/a.txt', 'team edit', 'team conflict')
        result = self.bootstrap(expected=2)
        clone = Path(result['result']['repo'])
        git(clone, 'merge', '--abort')
        git(clone, 'reset', '--hard', result['steps'][result['nextStep']]['target'])
        refused = self.command('continue', extra=('--workspace', str(self.root / 'bootstrap'), '--apply'), expected=1)
        self.assertIn('history', refused['error'])


if __name__ == '__main__':
    unittest.main()
