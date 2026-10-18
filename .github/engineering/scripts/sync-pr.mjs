import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  ['templates/PULL_REQUEST_TEMPLATE.md', '.github/PULL_REQUEST_TEMPLATE.md'],
  ['skills/pr/SKILL.md', '.agents/skills/pr/SKILL.md'],
  ['skills/pr/CREDITS.md', '.agents/skills/pr/CREDITS.md'],
  ['skills/pr/agents/openai.yaml', '.agents/skills/pr/agents/openai.yaml'],
];

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr?.trim() || result.error?.message || 'unknown error'}`);
  }
  return result.stdout.trim();
}

function assertNotSymlink(repo, path) {
  let current = repo;
  for (const part of path.split('/')) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Refusing symlink target: ${path}`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function sync(repo, apply) {
  if (!existsSync(join(repo, '.git'))) throw new Error('Target is not a Git working tree');
  const top = resolve(git(repo, ['rev-parse', '--show-toplevel']));
  if (top.toLowerCase() !== repo.toLowerCase()) throw new Error('Target must be the repository root');

  const changed = [];
  for (const [sourcePath, destinationPath] of files) {
    const source = readFileSync(join(sourceRoot, sourcePath));
    const target = join(repo, destinationPath);
    assertNotSymlink(repo, destinationPath);
    if (existsSync(target) && readFileSync(target).equals(source)) continue;
    changed.push({ path: destinationPath, target, source });
  }

  // Validate every affected path before writing anything. Do not partially overwrite user edits.
  if (apply) {
    for (const item of changed) {
      const status = git(repo, ['status', '--porcelain', '--', item.path]);
      if (status) {
        throw new Error(`Refusing to overwrite locally modified or untracked file: ${item.path} (${status})`);
      }
    }
    for (const item of changed) {
      mkdirSync(dirname(item.target), { recursive: true });
      writeFileSync(item.target, item.source);
    }
  }
  for (const { path } of changed) {
    console.log(`${apply ? 'Updated' : 'Out of sync'}: ${path}`);
  }
  if (!changed.length) console.log('PR template and skill match the canonical source.');
  else if (!apply) {
    console.error('Run with --apply to copy the canonical files after reviewing the target repository.');
    process.exitCode = 1;
  }
}

if (process.argv.length !== 4 || !['--check', '--apply'].includes(process.argv[2])) {
  console.error('Usage: node .github/engineering/scripts/sync-pr.mjs --check|--apply /path/to/repository');
  process.exitCode = 2;
} else {
  try {
    sync(resolve(process.argv[3]), process.argv[2] === '--apply');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
