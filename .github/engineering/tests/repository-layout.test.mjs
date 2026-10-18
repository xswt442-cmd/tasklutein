import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repositoryTemplate = fileURLToPath(new URL('../../PULL_REQUEST_TEMPLATE.md', import.meta.url));

test('GitHub PR template matches the canonical engineering template', () => {
  const canonical = readFileSync(new URL('../templates/PULL_REQUEST_TEMPLATE.md', import.meta.url));
  const applied = readFileSync(repositoryTemplate);
  assert.deepEqual(applied, canonical);
});

test('engineering guideline, PR template, and skill are consistent', () => {
  const standard = readFileSync(new URL('../ENGINEERING_STANDARD.md', import.meta.url), 'utf8');
  const skill = readFileSync(new URL('../skills/pr/SKILL.md', import.meta.url), 'utf8');
  const template = readFileSync(new URL('../templates/PULL_REQUEST_TEMPLATE.md', import.meta.url), 'utf8');
  assert.match(standard, /\.github\/PULL_REQUEST_TEMPLATE\.md/);
  assert.match(skill, /The repository template owns/);
  assert.match(skill, /No diagram by default/);
  assert.match(template, /### 变更[\s\S]*### 任务[\s\S]*### 验证[\s\S]*## English/);
  assert.match(template, /### Changes[\s\S]*### Tasks[\s\S]*### Verification/);
  assert.match(standard, /SHA-256 是完整性校验/);
});

test('CHANGELOG template requires meaningful bilingual change categories without empty placeholders', () => {
  const standard = readFileSync(new URL('../ENGINEERING_STANDARD.md', import.meta.url), 'utf8');
  const template = readFileSync(new URL('../templates/CHANGELOG.md', import.meta.url), 'utf8');
  for (const label of ['**新增**', '**改进**', '**修复**', '**Added**', '**Improved**', '**Fixed**']) {
    assert.ok(template.includes(label), `CHANGELOG example missing ${label}`);
    assert.ok(standard.includes(label), `standard missing ${label}`);
  }
  assert.match(standard, /只出现有实际内容的类别/);
  assert.match(template, /## \[Unreleased\]/);
  assert.match(template, /### 简体中文[\s\S]*### English/);
});
