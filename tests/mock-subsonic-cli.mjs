// Run the mock Subsonic server on its own (used by the desktop self-tests):  node tests/mock-subsonic-cli.mjs <dir with *.flac> <cover.png>
// Prints "mock: <url>" when ready; serves every .flac in <dir> as one album; user alice / password secret.
import fs from 'node:fs'; import path from 'node:path'; import { startMock } from './mock-subsonic.mjs';
const [dir, cover] = process.argv.slice(2), files = {}, songs = [];
fs.readdirSync(dir).filter(f => f.endsWith('.flac')).forEach((f, i) => { const id = 'x' + i; files[id] = path.join(dir, f); songs.push({ id, title: 'Remote ' + (i + 1), artist: 'Server Band', album: 'Cloud', albumId: 'al1', track: i + 1, suffix: 'flac', duration: 5, size: fs.statSync(files[id]).size, created: '2026-01-01T00:00:00Z', coverArt: 'al1' }); });
const m = await startMock({ songs, files, cover, port: +process.env.PORT || 0 }); console.log('mock: ' + m.url);
