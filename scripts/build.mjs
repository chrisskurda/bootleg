#!/usr/bin/env node
// Assembles dist/ — the static app both the browser and the Tauri shell serve:
//   src/*  +  the vendored visualizer (core/, packs/)  +  packs.json (the manifests, so the app can list packs without a server)
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), dist = path.join(root, 'dist'), VIS = path.join(root, 'vendor/bootleg-vizualizer');
fs.rmSync(dist, { recursive: true, force: true }); fs.mkdirSync(dist, { recursive: true });
fs.cpSync(path.join(root, 'src'), dist, { recursive: true });
for (const d of ['core', 'packs']) fs.cpSync(path.join(VIS, d), path.join(dist, 'vendor/bootleg-vizualizer', d), { recursive: true, filter: s => !s.includes('/cache') });
fs.copyFileSync(path.join(VIS, 'LICENSE'), path.join(dist, 'vendor/bootleg-vizualizer/LICENSE'));
const packs = fs.readdirSync(path.join(VIS, 'packs')).filter(n => fs.existsSync(path.join(VIS, 'packs', n, 'pack.json'))).map(n => { const m = JSON.parse(fs.readFileSync(path.join(VIS, 'packs', n, 'pack.json'), 'utf8')); return { id: n, ...m, page: m.page || 'index.html' }; });
fs.writeFileSync(path.join(dist, 'packs.json'), JSON.stringify(packs));
// build stamp (shown in Settings): which commit this build is
import { execSync } from 'node:child_process';
let commit = process.env.GITHUB_SHA?.slice(0, 7) || ''; try { commit ||= execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a git checkout */ }
fs.writeFileSync(path.join(dist, 'build.json'), JSON.stringify({ commit, date: new Date().toISOString().slice(0, 10), version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version }));
console.log(`dist/ ready: ${packs.length} packs, ${fs.readdirSync(dist).length} top-level entries`);
