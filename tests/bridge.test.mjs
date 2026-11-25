// Bridge: state snapshots and command handling against a fake player (no sockets, no DOM).
import { Bridge } from '../src/lib/bridge.js';
let fail = 0; const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };
globalThis.setInterval = () => 0;
const calls = [];
const stems = [{ name: 'kick', role: 'drums', mute: false, solo: false }, { name: 'bass', role: 'bass', mute: false, solo: false }];
const player = Object.assign(new EventTarget(), {
  item: { id: 't1', title: 'T', artist: 'A', album: 'B', kind: 'render', bpm: 120, key: 'Am' }, queue: [1, 2], index: 0, mode: 'deck', stemsState: 'ready', volume: 0.5, shuffle: false, repeat: 'off', playing: true,
  deck: { stems, applyGains: () => calls.push('gains') }, pos: () => 10, dur: () => 200, _emit: () => calls.push('emit'),
  toggle: () => calls.push('toggle'), next: () => calls.push('next'), seek: t => calls.push(['seek', t]), setVolume: v => calls.push(['vol', v]), setRepeat: v => calls.push(['rep', v]), setShuffle: v => calls.push(['shuf', v]),
});
const viz = { pack: { name: 'Radial' }, packs: [{ id: 'a' }, { id: 'b' }], setPack: id => calls.push(['pack', id]), _kick: () => calls.push('kick') };
const b = new Bridge({ player, viz });
const s = b.snapshot();
ok(s.track.title === 'T' && s.dur === 200 && s.stems.length === 2 && s.pack === 'Radial', 'snapshot carries track, duration, stems and pack');
b._cmd({ cmd: 'toggle' }); b._cmd({ cmd: 'seek', to: 0.25 }); b._cmd({ cmd: 'volume', to: 7 }); b._cmd({ cmd: 'repeat' }); b._cmd({ cmd: 'shuffle' });
ok(calls.includes('toggle'), 'toggle'); ok(JSON.stringify(calls.find(c => c[0] === 'seek')) === '["seek",50]', 'seek fraction maps to seconds');
ok(JSON.stringify(calls.find(c => c[0] === 'vol')) === '["vol",1]', 'volume is clamped'); ok(JSON.stringify(calls.find(c => c[0] === 'rep')) === '["rep","all"]', 'repeat cycles'); ok(JSON.stringify(calls.find(c => c[0] === 'shuf')) === '["shuf",true]', 'shuffle flips');
b._cmd({ cmd: 'stemMute', name: 'bass' }); b._cmd({ cmd: 'stemSolo', name: 'kick' });
ok(stems[1].mute && stems[0].solo && calls.includes('gains'), 'stem mute/solo reach the deck');
b._cmd({ cmd: 'pack', by: 1 }); ok(JSON.stringify(calls.find(c => c[0] === 'pack')) === '["pack","b"]', 'pack steps and wraps');
b._cmd({ cmd: 'frames', on: true }); ok(typeof viz.tap === 'function' && calls.includes('kick'), 'frames on installs the tap and wakes the loop');
const sent = []; b.ws = { readyState: 1, send: m => sent.push(JSON.parse(m)) }; viz.tap({ spectrum: new Float32Array(64).fill(0.5), level: 0.2, beat: 1, stems: [{ level: 1 }] });
ok(sent[0]?.type === 'frame' && sent[0].spec.length === 64 && sent[0].spec[0] === 128 && sent[0].beat === 1, 'frames are quantised to bytes');
b._cmd({ cmd: 'frames', on: false }); ok(viz.tap === null, 'frames off removes the tap');
process.exit(fail ? 1 : 0);
