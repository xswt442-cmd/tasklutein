import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/sync-pr.mjs', import.meta.url));
const standards = resolve(fileURLToPath(new URL('..', import.meta.url)));

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

test('check is read-only, apply updates four files, and dirty edits block overwrites', () => {
  const root = mkdtempSync(join(tmpdir(), 'engineering-cmd-pr-test-'));
  try {
    assert.equal(run('git', ['init', '--quiet', root], root).status, 0);
    writeFileSync(join(root, 'README.md'), 'Fixture\n');
    assert.equal(run('git', ['add', 'README.md'], root).status, 0);
    assert.equal(run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com',
      'commit', '--quiet', '-m', 'init'], root).status, 0);

    const absent = run(process.execPath, [script, '--check', root], root);
    assert.equal(absent.status, 1);
    assert.match(absent.stdout, /Out of sync: \.github\/PULL_REQUEST_TEMPLATE\.md/);
    assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), 'Fixture\n');

    const update = run(process.execPath, [script, '--apply', root], root);
    assert.equal(update.status, 0, update.stderr);
    assert.equal(run(process.execPath, [script, '--check', root], root).status, 0);
    assert.equal(readFileSync(join(root, '.agents/skills/pr/SKILL.md'), 'utf8'),
      readFileSync(join(standards, 'skills/pr/SKILL.md'), 'utf8'));
    assert.equal(readFileSync(join(root, '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8'),
      readFileSync(join(standards, 'templates/PULL_REQUEST_TEMPLATE.md'), 'utf8'));

    assert.equal(run('git', ['add', '.github', '.agents'], root).status, 0);
    assert.equal(run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com',
      'commit', '--quiet', '-m', 'install'], root).status, 0);
    writeFileSync(join(root, '.agents/skills/pr/SKILL.md'), 'User change\n');
    const refused = run(process.execPath, [script, '--apply', root], root);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /Refusing to overwrite locally modified/);
    assert.equal(readFileSync(join(root, '.agents/skills/pr/SKILL.md'), 'utf8'), 'User change\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
