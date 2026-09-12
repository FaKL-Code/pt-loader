import { execFileSync } from 'node:child_process';

const base = process.env.RELEASE_DIFF_BASE || '';
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

let changed = base && !/^0+$/.test(base) ? gitDiff([`${base}...HEAD`]) : gitDiff(['HEAD^', 'HEAD']);

if (changed.length === 0) {
  changed = [...new Set([...gitDiff([]), ...gitDiff(['--cached'])])];
}

const packageFiles = changed.filter((file) => packageChanges.test(file));
const documentationFiles = changed.filter((file) => docs.test(file));

if (packageFiles.length > 0 && documentationFiles.length === 0) {
  console.error(
    'Release discipline: package changes require a documentation change in the same commit.',
  );
  console.error(`Package files: ${packageFiles.join(', ')}`);
  console.error('Update README.md, CHANGELOG.md, CONTRIBUTING.md, AGENTS.md or docs/.');
  process.exit(1);
}

console.log(
  `Release discipline: ${packageFiles.length} package file(s), ${documentationFiles.length} documentation file(s).`,
);
