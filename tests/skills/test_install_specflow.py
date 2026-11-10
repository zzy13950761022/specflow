import subprocess
import sys
import tempfile
import unittest
import importlib.util
from unittest.mock import patch
from pathlib import Path

INSTALLER = Path(__file__).resolve().parents[2] / 'scripts/install-specflow-skill.py'


class SkillInstallation(unittest.TestCase):
    def test_backups_shared_links_and_repeat_install(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'repository/skills/specflow'
            source.mkdir(parents=True)
            (source / 'SKILL.md').write_text(chr(10).join(['---', 'name: specflow', 'description: Test skill', '---', 'New skill']))
            user_home = root / 'user'
            old_claude = user_home / '.claude/skills/specflow'
            old_claude.mkdir(parents=True)
            (old_claude / 'SKILL.md').write_text('Original Claude skill')
            arguments = [sys.executable, str(INSTALLER), '--source', str(source), '--user-home', str(user_home)]
            subprocess.run(arguments, check=True, capture_output=True, text=True)
            self.assertFalse((user_home / '.agents/skills/specflow').exists())
            self.assertEqual((old_claude / 'SKILL.md').read_text(), 'Original Claude skill')
            subprocess.run(arguments + ['--apply'], check=True, capture_output=True, text=True)
            shared = user_home / '.agents/skills/specflow'
            self.assertTrue(shared.is_symlink())
            self.assertEqual(shared.resolve(), source.resolve())
            self.assertTrue(old_claude.is_symlink())
            self.assertEqual(old_claude.readlink(), shared.parent.resolve() / 'specflow')
            backups = list((user_home / '.claude/skill-backups').glob('specflow-*'))
            self.assertEqual(len(backups), 1)
            self.assertEqual((backups[0] / 'SKILL.md').read_text(), 'Original Claude skill')
            subprocess.run(arguments + ['--apply'], check=True, capture_output=True, text=True)
            self.assertEqual(list((user_home / '.claude/skill-backups').glob('specflow-*')), backups)
            (source / 'SKILL.md').write_text('Updated source')
            self.assertEqual((shared / 'SKILL.md').read_text(), 'Updated source')
            self.assertEqual((old_claude / 'SKILL.md').read_text(), 'Updated source')


    def test_rejects_installation_from_a_directory_it_would_replace(self):
        with tempfile.TemporaryDirectory() as directory:
            user_home = Path(directory).resolve()
            source = user_home / '.claude/skills/specflow'
            source.mkdir(parents=True)
            (source / 'SKILL.md').write_text('Original skill')
            result = subprocess.run([sys.executable, str(INSTALLER), '--source', str(source), '--user-home', str(user_home), '--apply'], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(source.is_symlink())
            self.assertEqual((source / 'SKILL.md').read_text(), 'Original skill')
            self.assertFalse((user_home / '.agents/skills/specflow').exists())

    def test_restores_both_existing_skills_if_the_second_link_fails(self):
        module_spec = importlib.util.spec_from_file_location('specflow_installer', INSTALLER)
        installer = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(installer)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = root / 'source'
            source.mkdir()
            (source / 'SKILL.md').write_text('New skill')
            user_home = root / 'user'
            for client in ['.agents', '.claude']:
                target = user_home / client / 'skills/specflow'
                target.mkdir(parents=True)
                (target / 'SKILL.md').write_text('Original ' + client)
            rename = Path.rename

            def fail_second_link(path, target):
                if path.name.startswith('.specflow-link-') and '.claude' in path.parts:
                    raise OSError('Simulated link failure')
                return rename(path, target)

            with patch.object(Path, 'rename', fail_second_link):
                with self.assertRaises(OSError):
                    installer.install(source, user_home, apply=True)
            for client in ['.agents', '.claude']:
                target = user_home / client / 'skills/specflow'
                self.assertFalse(target.is_symlink())
                self.assertEqual((target / 'SKILL.md').read_text(), 'Original ' + client)

    def test_existing_shared_skill_is_preserved_outside_discovery_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source'
            source.mkdir()
            (source / 'SKILL.md').write_text('New skill')
            user_home = root / 'user'
            shared = user_home / '.agents/skills/specflow'
            shared.mkdir(parents=True)
            (shared / 'SKILL.md').write_text('Original shared skill')
            subprocess.run([sys.executable, str(INSTALLER), '--source', str(source), '--user-home', str(user_home), '--apply'], check=True, capture_output=True, text=True)
            backups = list((user_home / '.agents/skill-backups').glob('specflow-*'))
            self.assertEqual(len(backups), 1)
            self.assertEqual((backups[0] / 'SKILL.md').read_text(), 'Original shared skill')
            self.assertEqual(shared.resolve(), source.resolve())


if __name__ == '__main__':
    unittest.main()
