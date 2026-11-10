#!/usr/bin/env python3
"""Install the repository skill as shared user-level links, preserving old copies."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4


def install(source, user_home, apply=False):
    source = source.resolve()
    if not (source / 'SKILL.md').is_file():
        raise ValueError('Source must contain SKILL.md: ' + str(source))
    shared = user_home / '.agents/skills/specflow'
    targets = [(shared, source), (user_home / '.claude/skills/specflow', shared)]
    if any(source == target or target in source.parents for target, _ in targets):
        raise ValueError('Keep the maintained source outside the installation targets to avoid circular links.')
    changes = []
    suffix = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + str(uuid4())
    try:
        for target, link_source in targets:
            if target.is_symlink() and target.readlink() == link_source:
                print('Already linked: ' + str(target))
                continue
            exists = target.exists() or target.is_symlink()
            backup = target.parents[1] / 'skill-backups' / ('specflow-' + suffix) if exists else None
            print(('Install: ' if apply else 'Preview: ') + str(target) + ' -> ' + str(link_source))
            if backup:
                print('Backup: ' + str(backup))
            if not apply:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name('.specflow-link-' + suffix)
            temporary.symlink_to(link_source, target_is_directory=True)
            moved = False
            try:
                if backup:
                    backup.parent.mkdir(parents=True, exist_ok=True)
                    target.rename(backup)
                    moved = True
                temporary.rename(target)
                changes.append((target, backup))
            except Exception:
                if moved:
                    backup.rename(target)
                raise
            finally:
                if temporary.is_symlink():
                    temporary.unlink()
        if apply:
            for target, _ in targets:
                if target.resolve() != source or not (target / 'SKILL.md').is_file():
                    raise RuntimeError('Installed link failed verification: ' + str(target))
    except Exception:
        for target, backup in reversed(changes):
            target.unlink()
            if backup:
                backup.rename(target)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[1] / 'skills/specflow')
    parser.add_argument('--user-home', type=Path, default=Path.home())
    parser.add_argument('--apply', action='store_true', help='Write links and preserve existing skills in backups; otherwise preview only')
    arguments = parser.parse_args()
    install(arguments.source, arguments.user_home.resolve(), arguments.apply)
