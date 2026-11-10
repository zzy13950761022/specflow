#!/usr/bin/env python3
"""Preview-first, local Git subtree synchronization in isolated review clones."""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tempfile
import uuid


class SyncError(Exception):
    pass


def run(repo, *args, check=True):
    result = subprocess.run(
        ['git', '-C', str(repo), *args], capture_output=True, text=True,
        env={**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GIT_MERGE_AUTOEDIT': 'no'},
    )
    if check and result.returncode:
        raise SyncError(result.stderr.strip() or result.stdout.strip() or 'Git command failed')
    return result


def git(repo, *args):
    return run(repo, *args).stdout.strip()


def commit(repo, ref):
    if not ref or ref.startswith('-') or any(c in ref for c in '\r\n\0'):
        raise SyncError('Invalid commit ref')
    return git(repo, 'rev-parse', '--verify', '--end-of-options', ref + '^{commit}')


def validate_prefix(prefix):
    path = PurePosixPath(prefix)
    if (not prefix or prefix.startswith('-') or path.is_absolute()
            or any(part in ('', '.', '..', '.git') for part in prefix.split('/'))
            or any(c in prefix for c in '\r\n\0\\')):
        raise SyncError('Invalid prefix: use a relative repository directory')


def tree(repo, ref, prefix=None):
    spec = ref + (':' + prefix if prefix else '^{tree}')
    value = git(repo, 'rev-parse', '--verify', spec)
    if git(repo, 'cat-file', '-t', value) != 'tree':
        raise SyncError('Team prefix must be an existing committed directory')
    return value


def dirty(repo):
    return bool(git(repo, 'status', '--porcelain', '--untracked-files=normal'))


def ancestor(repo, base, tip):
    return run(repo, 'merge-base', '--is-ancestor', base, tip, check=False).returncode == 0


def clone(original, target, ref):
    run(original, 'clone', '--no-hardlinks', '--no-checkout', '--', str(original), str(target))
    for key in ('user.name', 'user.email'):
        value = run(original, 'config', '--get', key, check=False).stdout.strip()
        if not value:
            raise SyncError('Configure ' + key + ' in ' + str(original) + ' before applying sync')
        git(target, 'config', key, value)
    git(target, 'config', 'commit.gpgsign', 'false')
    git(target, 'config', 'core.hooksPath', '/dev/null')
    git(target, 'checkout', '--detach', ref)


def split(repo, ref, prefix, rejoin=False):
    args = ['subtree', 'split', '--prefix=' + prefix]
    if rejoin:
        args.append('--rejoin')
    args.append(ref)
    return git(repo, *args).splitlines()[-1]


def fetch(repo, other, sha):
    git(repo, 'fetch', '--no-tags', '--', str(other), sha)


def save(workspace, record):
    temporary = workspace / 'operation.json.tmp'
    temporary.write_text(json.dumps(record, indent=2) + '\n')
    temporary.replace(workspace / 'operation.json')


def conflicts(repo):
    return run(repo, 'diff', '--name-only', '--diff-filter=U', '-z').stdout.rstrip('\0').split('\0') if git(repo, 'ls-files', '-u') else []


def outside_tree(repo, sha, prefix):
    entries = run(repo, 'ls-tree', '-r', '-z', sha).stdout.split('\0')
    return sorted(entry for entry in entries if entry and not entry.split('\t', 1)[1].startswith(prefix + '/'))


def output(record, workspace):
    return {**record, 'workspace': str(workspace)}


def finish_steps(workspace, record, continuing=False):
    repo = workspace / ('team' if record['operation'] == 'export' else 'source')
    if not repo.is_dir() or repo.is_symlink():
        raise SyncError('Missing isolated result repository')
    if git(repo, 'symbolic-ref', '--short', 'HEAD') != record['result']['branch']:
        raise SyncError('Result branch changed; restore the recorded branch before continuing')
    if continuing and record['status'] == 'conflict':
        if not ancestor(repo, record['result']['commit'], 'HEAD'):
            raise SyncError('Result history no longer preserves the pre-conflict commit')
        if conflicts(repo):
            record['conflicts'] = conflicts(repo)
            save(workspace, record)
            return output(record, workspace), 2
        pending = record['steps'][record['nextStep']]
        if run(repo, 'rev-parse', '--verify', 'MERGE_HEAD', check=False).returncode == 0:
            git(repo, 'commit', '--no-edit')
        if not ancestor(repo, pending['target'], 'HEAD'):
            raise SyncError('Pending merge was aborted; restore or complete it before continuing')
        record['nextStep'] += 1
        record.pop('conflicts', None)
        record['status'] = 'running'
        save(workspace, record)
    while record['nextStep'] < len(record['steps']):
        step = record['steps'][record['nextStep']]
        if step['kind'] == 'subtree':
            args = ['subtree', 'merge', '--prefix=' + record['prefix'], step['target'], '-m', step['message']]
        else:
            args = ['merge', '--no-edit', '--no-ff', '-m', step['message']]
            if step.get('unrelated'):
                args.append('--allow-unrelated-histories')
            args.append(step['target'])
        result = run(repo, *args, check=False)
        if result.returncode:
            unresolved = conflicts(repo)
            if not unresolved:
                raise SyncError(result.stderr.strip() or result.stdout.strip())
            record.update(status='conflict', conflicts=unresolved)
            record['result']['commit'] = git(repo, 'rev-parse', 'HEAD')
            save(workspace, record)
            return output(record, workspace), 2
        record['nextStep'] += 1
        save(workspace, record)
    result_sha = git(repo, 'rev-parse', 'HEAD')
    if dirty(repo):
        raise SyncError('Result has uncommitted changes; review and commit the resolution before continuing')
    if not ancestor(repo, record['sourceCommit'], result_sha):
        raise SyncError('Result history no longer preserves the selected source commit')
    team_ancestor = record['teamCommit'] if record['operation'] == 'export' else record['teamSplit']
    if not ancestor(repo, team_ancestor, result_sha):
        raise SyncError('Result history no longer preserves the selected team commit')
    if record['operation'] == 'export':
        if outside_tree(repo, record['teamCommit'], record['prefix']) != outside_tree(repo, result_sha, record['prefix']):
            raise SyncError('Export changed files outside the component prefix; result requires review')
        record['treesEqual'] = tree(repo, result_sha, record['prefix']) == record['sourceTree']
        record['needsFollowupImport'] = not record['treesEqual']
    else:
        record['treesEqual'] = tree(repo, result_sha) == record['teamTree']
    record.update(status='ready')
    record['result']['commit'] = result_sha
    save(workspace, record)
    return output(record, workspace), 0


def execute(args):
    validate_prefix(args.prefix)
    if args.operation == 'continue':
        if not args.workspace:
            raise SyncError('continue requires --workspace')
        workspace = Path(args.workspace).resolve()
        record = json.loads((workspace / 'operation.json').read_text())
        if record.get('operation') not in ('bootstrap', 'import', 'export'):
            raise SyncError('Invalid operation record')
        validate_prefix(record['prefix'])
        if not args.apply:
            return {**output(record, workspace), 'status': 'preview'}, 0
        if record['status'] == 'ready':
            repo = workspace / ('team' if record['operation'] == 'export' else 'source')
            if git(repo, 'rev-parse', 'HEAD') != record['result']['commit'] or dirty(repo):
                raise SyncError('Ready result changed; review its history in a new sync operation')
            return output(record, workspace), 0
        return finish_steps(workspace, record, continuing=True)

    source = Path(args.source).expanduser().resolve()
    team = Path(args.team).expanduser().resolve()
    for repo in (source, team):
        if git(repo, 'rev-parse', '--show-toplevel') != str(repo):
            raise SyncError('Use repository root paths')
    source_sha, team_sha = commit(source, args.source_ref), commit(team, args.team_ref)
    source_tree, team_tree = tree(source, source_sha), tree(team, team_sha, args.prefix)
    record = dict(operation=args.operation, status='status' if args.operation == 'status' else 'preview',
                  prefix=args.prefix, sourceRepo=str(source), teamRepo=str(team),
                  sourceCommit=source_sha, teamCommit=team_sha, sourceTree=source_tree, teamTree=team_tree,
                  sourceDirty=dirty(source), teamDirty=dirty(team), treesEqual=source_tree == team_tree)
    if args.operation == 'status':
        return record, int(args.require_equal and not record['treesEqual'])
    if not args.apply:
        return record, 0
    if record['sourceDirty'] or record['teamDirty']:
        raise SyncError('Repositories have uncommitted changes; commit or resolve them before --apply')
    if source == team:
        raise SyncError('Source and team must be separate repositories')
    source_base = team_base = None
    if args.operation == 'bootstrap':
        if not args.source_base or not args.team_base:
            raise SyncError('bootstrap requires explicit --source-base and --team-base')
        source_base, team_base = commit(source, args.source_base), commit(team, args.team_base)
        if not ancestor(source, source_base, source_sha) or not ancestor(team, team_base, team_sha):
            raise SyncError('Bootstrap bases must be ancestors of the selected tips')
        tree(team, team_base, args.prefix)
    workspace = Path(args.workspace).expanduser().resolve() if args.workspace else Path(tempfile.mkdtemp(prefix='ai-pilot-sync-')).resolve()
    for original in (source, team):
        if workspace == original or original in workspace.parents or workspace in original.parents:
            raise SyncError('Workspace must be separate from both original repositories')
    if args.workspace:
        workspace.mkdir(parents=True, exist_ok=False)
    record.update(status='running', steps=[], nextStep=0)
    branch = 'codex/ai-pilot-' + args.operation + '-' + uuid.uuid4().hex[:12]
    clone(source, workspace / 'source', source_sha)
    clone(team, workspace / 'team', team_sha)
    out = workspace / ('team' if args.operation == 'export' else 'source')
    record['result'] = dict(repo=str(out), branch=branch)
    if args.operation == 'bootstrap':
        base_split = split(workspace / 'team', team_base, args.prefix)
        tip_split = split(workspace / 'team', team_sha, args.prefix)
        fetch(out, workspace / 'team', tip_split)
        fetch(out, workspace / 'team', base_split)
        git(out, 'checkout', '-b', branch, source_base)
        record.update(sourceBase=source_base, teamBase=team_base, teamBaseSplit=base_split, teamSplit=tip_split)
        record['steps'] = [dict(kind='merge', target=base_split, unrelated=True, message='sync: join reviewed AI Pilot histories'),
                           dict(kind='merge', target=source_sha, message='sync: preserve personal changes since baseline'),
                           dict(kind='merge', target=tip_split, message='sync: import team changes since baseline')]
    elif args.operation == 'import':
        tip_split = split(workspace / 'team', team_sha, args.prefix)
        fetch(out, workspace / 'team', tip_split)
        if run(out, 'merge-base', source_sha, tip_split, check=False).returncode:
            raise SyncError('Histories are unrelated; use bootstrap with reviewed historical bases first')
        git(out, 'checkout', '-b', branch, source_sha)
        record['teamSplit'] = tip_split
        record['steps'] = [dict(kind='merge', target=tip_split, message='sync: import AI Pilot team changes')]
    else:
        git(out, 'checkout', '-b', branch, team_sha)
        tip_split = split(out, team_sha, args.prefix, rejoin=True)
        fetch(out, workspace / 'source', source_sha)
        if run(out, 'merge-base', source_sha, tip_split, check=False).returncode:
            raise SyncError('Histories are unrelated; use bootstrap with reviewed historical bases first')
        record['teamSplit'] = tip_split
        record['steps'] = [dict(kind='subtree', target=source_sha, message='sync: merge AI Pilot personal changes')]
    save(workspace, record)
    return finish_steps(workspace, record)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['status', 'bootstrap', 'import', 'export', 'continue'])
    parser.add_argument('--source', default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument('--team', default=str(Path.home() / 'Project/Giant-Panda-AI-Tools-main'))
    parser.add_argument('--prefix', default='mcp/ai-pilot')
    parser.add_argument('--source-ref', default='HEAD')
    parser.add_argument('--team-ref', default='HEAD')
    parser.add_argument('--source-base')
    parser.add_argument('--team-base')
    parser.add_argument('--workspace')
    parser.add_argument('--apply', action='store_true', help='Create an isolated review result; never push')
    parser.add_argument('--require-equal', action='store_true', help='status fails if committed trees differ')
    args = parser.parse_args()
    try:
        result, code = execute(args)
    except (SyncError, OSError, ValueError, KeyError, IndexError) as error:
        result, code = {'error': str(error)}, 1
    print(json.dumps(result, ensure_ascii=False))
    return code


if __name__ == '__main__':
    sys.exit(main())
