import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE_TAG = /^(?:[a-z][a-z0-9-]*-)?v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const VERSION_HEADING = /^## \[([^\]]+)\](?: - .+)?$/;

export function versionFromTag(tag) {
  const match = RELEASE_TAG.exec(tag);
  if (!match) {
    throw new Error('release tag must use vX.Y.Z or product-vX.Y.Z');
  }
  return match[1];
}

export function checkManifestVersion(manifestContent, tag) {
  const manifest = JSON.parse(manifestContent);
  const version = versionFromTag(tag);
  if (manifest === null || typeof manifest !== 'object' || manifest.version !== version) {
    throw new Error('tag version does not match product manifest version');
  }
}

function requireLanguage(body, label) {
  const positions = body
    .map((line, index) => line.trim() === label ? index : -1)
    .filter((index) => index >= 0);
  if (positions.length !== 1) {
    throw new Error('release requires exactly one ' + label + ' section');
  }
  return positions[0];
}

export function extractReleaseNotes(changelog, tag) {
  const version = versionFromTag(tag);
  const lines = changelog.split(/\r?\n/);
  const matches = [];
  for (const [index, line] of lines.entries()) {
    const match = VERSION_HEADING.exec(line);
    if (match && match[1] === version) matches.push(index);
  }
  if (matches.length !== 1) {
    throw new Error('changelog must have exactly one [' + version + '] section');
  }

  const start = matches[0];
  let end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end);
  // Keep a Changelog commonly appends link reference definitions after its final version.
  while (body.length && (!body.at(-1).trim() || /^\[[^\]]+\]:\s+\S+/.test(body.at(-1)))) {
    body.pop();
  }
  const zh = requireLanguage(body, '### 简体中文');
  const en = requireLanguage(body, '### English');
  if (zh >= en) throw new Error('Chinese section must precede English section');

  const chinese = body.slice(zh + 1, en).join('\n').trim();
  const english = body.slice(en + 1).join('\n').trim();
  for (const [language, section] of [['简体中文', chinese], ['English', english]]) {
    if (!section || /<!--[\s\S]*?-->/.test(section)) {
      throw new Error(language + ' release section is empty or contains template comments');
    }
    if (section.includes('TODO') || section.includes('TBD')) {
      throw new Error(language + ' release section contains an unfinished placeholder');
    }
  }
  return '# ' + tag + '\n\n' + body.join('\n').trim() + '\n';
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.length % 2 !== 0) {
    throw new Error('usage: node scripts/release-notes.mjs --changelog FILE --tag TAG [--manifest FILE]');
  }
  const allowed = new Set(['--changelog', '--tag', '--manifest']);
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!allowed.has(argv[i]) || Object.hasOwn(args, argv[i]) || !argv[i + 1]) {
      throw new Error('invalid or repeated option: ' + argv[i]);
    }
    args[argv[i]] = argv[i + 1];
  }
  if (!args['--changelog'] || !args['--tag']) {
    throw new Error('both --changelog and --tag are required');
  }
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const tag = args['--tag'];
    if (args['--manifest']) {
      checkManifestVersion(readFileSync(resolve(args['--manifest']), 'utf8'), tag);
    }
    const changelog = readFileSync(resolve(args['--changelog']), 'utf8');
    process.stdout.write(extractReleaseNotes(changelog, tag));
  } catch (error) {
    process.stderr.write('release-notes: ' + error.message + '\n');
    process.exitCode = 1;
  }
}
