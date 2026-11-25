// Release hygiene (run by `npm test` and CI): the version must be the same everywhere, and CHANGELOG.md must describe it.
//   package.json  ·  src-tauri/tauri.conf.json  ·  src-tauri/Cargo.toml  ·  a "## [x.y.z] - date" heading in CHANGELOG.md  ·  an [Unreleased] section
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), read = f => fs.readFileSync(path.join(root, f), 'utf8');
const v = { 'package.json': JSON.parse(read('package.json')).version, 'src-tauri/tauri.conf.json': JSON.parse(read('src-tauri/tauri.conf.json')).version, 'src-tauri/Cargo.toml': /^version\s*=\s*"([^"]+)"/m.exec(read('src-tauri/Cargo.toml'))?.[1] };
const log = read('CHANGELOG.md'), bad = [];
if (new Set(Object.values(v)).size !== 1) bad.push('versions differ: ' + JSON.stringify(v));
const ver = v['package.json']; if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(ver)) bad.push(`"${ver}" is not a semantic version`);
if (!new RegExp(`^## \\[${ver.replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}`, 'm').test(log)) bad.push(`CHANGELOG.md has no "## [${ver}] - YYYY-MM-DD" entry`);
if (!/^## \[Unreleased\]/m.test(log)) bad.push('CHANGELOG.md has no "## [Unreleased]" section');
if (bad.length) { console.error('version check FAILED:\n - ' + bad.join('\n - ')); process.exit(1); } console.log(`version ${ver}: consistent, changelog entry present`);
