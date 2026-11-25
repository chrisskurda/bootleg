// Bridge: state snapshots and command handling against a fake player (no sockets, no DOM).
import { Bridge } from './bridge.js';
let fail = 0; const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };
globalThis.setInterval = () => 0;
const calls = [];
const stems = [{ name: 'kick', role: 'drums', mute: false, solo: false }, { name: 'bass', role: 'bass', mute: false, solo: false }];
const player = Object.assign(new EventTarget(), {
  item: { id: 't1', title: 'T', artist: 'A', album: 'B', kind: 'render', bpm: 120, key: 'Am' }, queue: [1, 2], index: 0, mode: 'deck', stemsState: 'ready', volume: 0.5, shuffle: false, repeat: 'off', playing: true,
  deck: { stems, applyGains: () => calls.push('gains') }, pos: () => 10, dur: () => 200, _emit: () => calls.push('emit'),
  toggle: () => calls.push('toggle'), next: () => calls.push('next'), seek: t => calls.push(['seek', t]), setVolume: v => calls.push(['vol', v]), setRepeat: v => calls.push(['rep', v]), setShuffle: v => calls.push(['shuf', v]),
});
let tap = null; const viz = { pack: { name: 'Radial' }, packs: [{ id: 'a' }, { id: 'b' }], setPack: id => calls.push(['pack', id]), onFrame: cb => { tap = cb; calls.push('kick'); return () => { tap = null; }; } };
const b = new Bridge({ player, viz });
const s = b.snapshot();
ok(s.track.title === 'T' && s.dur === 200 && s.stems.length === 2 && s.pack === 'Radial', 'snapshot carries track, duration, stems and pack');
b._cmd({ cmd: 'toggle' }); b._cmd({ cmd: 'seek', to: 0.25 }); b._cmd({ cmd: 'volume', to: 7 }); b._cmd({ cmd: 'repeat' }); b._cmd({ cmd: 'shuffle' });
ok(calls.includes('toggle'), 'toggle'); ok(JSON.stringify(calls.find(c => c[0] === 'seek')) === '["seek",50]', 'seek fraction maps to seconds');
ok(JSON.stringify(calls.find(c => c[0] === 'vol')) === '["vol",1]', 'volume is clamped'); ok(JSON.stringify(calls.find(c => c[0] === 'rep')) === '["rep","all"]', 'repeat cycles'); ok(JSON.stringify(calls.find(c => c[0] === 'shuf')) === '["shuf",true]', 'shuffle flips');
b._cmd({ cmd: 'stemMute', name: 'bass' }); b._cmd({ cmd: 'stemSolo', name: 'kick' });
ok(stems[1].mute && stems[0].solo && calls.includes('gains'), 'stem mute/solo reach the deck');
b._cmd({ cmd: 'pack', by: 1 }); ok(JSON.stringify(calls.find(c => c[0] === 'pack')) === '["pack","b"]', 'pack steps and wraps');
b._cmd({ cmd: 'frames', on: true }); ok(typeof tap === 'function' && calls.includes('kick'), 'frames on installs the tap and wakes the loop');
const sent = []; b.ws = { readyState: 1, send: m => sent.push(JSON.parse(m)) }; tap({ spectrum: new Float32Array(64).fill(0.5), wave: new Float32Array(128), bass: 1, mid: 0, high: 0, level: 0.2, beat: 1, t: 12.5, stems: [{ name: 'kick', role: 'kick', level: 1, beat: 0, spectrum: new Float32Array(16).fill(1), gainDb: -3, label: 'k1' }] });
const dec = b => Uint8Array.from(atob(b), c => c.charCodeAt(0)), f = sent[0];
ok(f?.type === 'frame' && dec(f.s).length === 64 && dec(f.s)[0] === 128 && f.f[0] === 255 && f.f[3] === 255 && f.t === 12.5, 'frames are quantised to bytes');
ok(dec(f.w).length === 128 && dec(f.w)[0] === 128, 'the waveform is shifted into byte range');
ok(f.stems[0].n === 'kick' && dec(f.stems[0].s).length === 16 && f.stems[0].g === -3 && f.stems[0].lb === 'k1' && f.stems[0].a === 1, 'stems carry level, 16 bands, gain and label');
b._cmd({ cmd: 'frames', on: false }); ok(tap === null, 'frames off removes the tap'); b.dispose();
process.exit(fail ? 1 : 0);
