import { execFileSync } from 'node:child_process';

const base = process.env.RELEASE_DIFF_BASE || '';
const releaseBuild = process.env.RELEASE_BUILD === '1';
const docs = /^(README\.md|CHANGELOG\.md|CONTRIBUTING\.md|AGENTS\.md|docs\/)/i;
const packageChanges = /^(src\/|types\/|bin\/|scripts\/|package\.json|\.github\/)/i;

function gitDiff(args) {
  try {
    return execFileSync('git', ['diff', '--name-only', ...args], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((file) => file.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

let changed =
  base && !/^0+$/.test(base)
    ? gitDiff([`${base}...HEAD`])
    : [...gitDiff(['HEAD']), ...gitDiff(['--cached'])];

if (changed.length === 0) {
  changed = gitDiff(['HEAD^', 'HEAD']);
}

const packageFiles = changed.filter((file) => packageChanges.test(file));
const documentationFiles = changed.filter((file) => docs.test(file));
const isolatedVersionBump =
  releaseBuild &&
  packageFiles.length > 0 &&
  packageFiles.every((file) => file === 'package.json') &&
  documentationFiles.length === 0;

if (packageFiles.length > 0 && documentationFiles.length === 0 && !isolatedVersionBump) {
  console.error(
    'Release discipline: package changes require a documentation change in the same commit.',
  );
  console.error(`Package files: ${packageFiles.join(', ')}`);
  console.error('Update README.md, CHANGELOG.md, CONTRIBUTING.md, AGENTS.md or docs/.');
  process.exit(1);
}

if (isolatedVersionBump) {
  console.log('Release discipline: accepting the isolated CI package.json version bump.');
}

console.log(
  `Release discipline: ${packageFiles.length} package file(s), ${documentationFiles.length} documentation file(s).`,
);
