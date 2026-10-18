import test from 'node:test';
import assert from 'node:assert/strict';
import { checkManifestVersion, extractReleaseNotes, versionFromTag } from '../scripts/release-notes.mjs';

const changelog = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '### 简体中文',
  '',
  '### English',
  '',
  '## [1.2.4] - 2026-10-18',
  '',
  '### 简体中文',
  '',
  '- 修复列表筛选。',
  '',
  '### English',
  '',
  '- Fixed list filtering.',
  '',
  '## [1.2.3] - 2026-10-17',
  '',
  '### 简体中文',
  '',
  '- 新增分页。',
  '',
  '### English',
  '',
  '- Added pagination.',
  '',
].join('\n');

test('extracts exactly the target version in two languages', () => {
  const release = extractReleaseNotes(changelog, 'v1.2.4');
  assert.match(release, /^# v1\.2\.4\n/);
  assert.match(release, /修复列表筛选/);
  assert.match(release, /Fixed list filtering/);
  assert.doesNotMatch(release, /新增分页/);
  assert.doesNotMatch(release, /Unreleased/);
});

test('supports product-scoped tags', () => {
  assert.equal(versionFromTag('desktop-v1.2.3'), '1.2.3');
  assert.match(extractReleaseNotes(changelog, 'cli-v1.2.3'), /Added pagination/);
});

test('rejects invalid tag and missing version', () => {
  assert.throws(() => versionFromTag('preview'), /tag must use/);
  assert.throws(() => extractReleaseNotes(changelog, 'v2.0.0'), /exactly one/);
});

test('rejects duplicate matching version headings', () => {
  assert.throws(() => extractReleaseNotes(changelog + '\n## [1.2.4]\n', 'v1.2.4'), /exactly one/);
});

test('rejects missing or reversed bilingual sections', () => {
  assert.throws(() => extractReleaseNotes(changelog.replace('### English\n\n- Fixed list filtering.', '### 英语\n\n- Fixed list filtering.'), 'v1.2.4'), /English/);
  assert.throws(() => extractReleaseNotes(changelog.replace('### 简体中文\n\n- 修复列表筛选。', '### 中文\n\n- 修复列表筛选。'), 'v1.2.4'), /简体中文/);
  const reversed = changelog.replace('### 简体中文\n\n- 修复列表筛选。\n\n### English\n\n- Fixed list filtering.', '### English\n\n- Fixed list filtering.\n\n### 简体中文\n\n- 修复列表筛选。');
  assert.throws(() => extractReleaseNotes(reversed, 'v1.2.4'), /precede/);
});

test('rejects empty language and template placeholders', () => {
  const empty = changelog.replace('- 修复列表筛选。', '');
  assert.throws(() => extractReleaseNotes(empty, 'v1.2.4'), /empty/);
  const draft = changelog.replace('- 修复列表筛选。', '<!-- insert changes -->');
  assert.throws(() => extractReleaseNotes(draft, 'v1.2.4'), /template comments/);
  assert.throws(() => extractReleaseNotes(changelog.replace('- 修复列表筛选。', '- TODO item'), 'v1.2.4'), /placeholder/);
});

test('enforces optional product manifest version', () => {
  checkManifestVersion('{"version":"1.2.4"}', 'v1.2.4');
  assert.throws(() => checkManifestVersion('{"version":"1.2.3"}', 'v1.2.4'), /does not match/);
});

test('does not include trailing changelog compare reference definitions', () => {
  const withLinks = changelog + '[Unreleased]: https://example.com/compare/v1.2.4...main\n[1.2.3]: https://example.com/compare/v1.2.2...v1.2.3\n';
  const release = extractReleaseNotes(withLinks, 'v1.2.3');
  assert.match(release, /Added pagination/);
  assert.doesNotMatch(release, /https:\/\/example.com/);
});

test('preserves classified bilingual Added, Changed, and Fixed entries without forcing empty categories', () => {
  const grouped = [
    '# Changelog',
    '',
    '## [2.0.0] - 2026-10-18',
    '',
    '### 简体中文',
    '',
    '**新增**',
    '- 新增终端搜索。',
    '',
    '**改进**',
    '- 改进快捷键。',
    '',
    '**修复**',
    '- 修复焦点丢失。',
    '',
    '### English',
    '',
    '**Added**',
    '- Added terminal search.',
    '',
    '**Improved**',
    '- Improved shortcuts.',
    '',
    '**Fixed**',
    '- Fixed focus loss.',
    '',
  ].join('\n');
  const notes = extractReleaseNotes(grouped, 'v2.0.0');
  assert.match(notes, /\*\*新增\*\*[\s\S]*\*\*改进\*\*[\s\S]*\*\*修复\*\*/);
  assert.match(notes, /\*\*Added\*\*[\s\S]*\*\*Improved\*\*[\s\S]*\*\*Fixed\*\*/);
  assert.doesNotMatch(notes, /Security|兼容性|Removed/);
  assert.ok(notes.indexOf('### 简体中文') < notes.indexOf('### English'));
});

test('allows a fix-only version, including legacy unclassified release history', () => {
  const fixed = [
    '## [2.0.1]',
    '### 简体中文',
    '**修复**',
    '- 修复窗口焦点。',
    '### English',
    '**Fixed**',
    '- Fixed window focus.',
  ].join('\n');
  assert.match(extractReleaseNotes(fixed, 'v2.0.1'), /\*\*Fixed\*\*/);
  assert.match(extractReleaseNotes(changelog, 'v1.2.4'), /- Fixed list filtering\./);
});
