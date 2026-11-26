// The mixer's arithmetic: keys, tempo matching, where a transition starts, what may be decoded whole.
import { keyInfo, keyName, keyRelation, matchRate, transitionStart, decodable, MAX_DECODE_SECONDS } from '../src/lib/mixer.js';
let bad = 0; const t = (n, ok, note = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${note ? '   ' + note : ''}`); if (!ok) bad++; };
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

t('keys parse in the usual spellings', JSON.stringify(['E m', 'F#m', 'c#min', 'Bb', 'Abmaj', 'x'].map(keyInfo)) === JSON.stringify([{ pc: 4, minor: true }, { pc: 6, minor: true }, { pc: 1, minor: true }, { pc: 10, minor: false }, { pc: 8, minor: false }, null]));
t('a key shifted by a tempo change is named', keyName('A m', 2) === 'Bm' && keyName('C', -1) === 'B' && keyName('?') === '');
t('key relations: same, relative, adjacent (fifths), clash', keyRelation('A m', 'Am') === 'same' && keyRelation('A m', 'C') === 'relative' && keyRelation('C', 'A m') === 'relative' && keyRelation('C', 'G') === 'adjacent' && keyRelation('C', 'F') === 'adjacent' && keyRelation('C', 'F#') === 'clash' && keyRelation('C', '') === null);
t('…and a pitch shift counts', keyRelation('C', 'B', 1) === 'same');
t('matchRate: the nearest of same, double and half time, within −20 / +25 %', near(matchRate(128, 124), 128 / 124) && near(matchRate(140, 70), 1) && near(matchRate(87, 174), 1) && near(matchRate(120, 60), 1) && near(matchRate(100, 120), 100 / 120) && near(matchRate(100, 160), 200 / 160));
t('matchRate: out of reach or unknown → 1', matchRate(100, 130) === 1 && matchRate(100, 140) === 1 && matchRate(0, 120) === 1 && matchRate(120, 0) === 1);
t('gapless starts the next track at the very end', transitionStart({ dur: 200, pos: 10 }) === 200);
t('a crossfade starts `xf` real seconds before the end (rate counts)', transitionStart({ dur: 200, pos: 10, xf: 8 }) === 192 && transitionStart({ dur: 200, pos: 10, xf: 8, rate: 1.05 }) === 200 - 8.4);
const bar = 240 / 120;   // 2 s at 120 BPM
t('with tempo matching it moves back to a bar line', transitionStart({ dur: 201, pos: 10, xf: 8, bpm: 120, onBar: true }) === Math.floor(193 / bar) * bar);
t('never in the past: a seek near the end starts it a moment from now', transitionStart({ dur: 200, pos: 199, xf: 8 }) === 199.25 && transitionStart({ dur: 200, pos: 199.9 }) === 200);
const track = (o = {}) => ({ kind: 'track', src: { size: 30e6 }, duration: 240, ...o });
t('an ordinary track may be decoded whole', decodable(track()));
t('a long one (a DJ mix) streams instead', !decodable(track({ duration: MAX_DECODE_SECONDS + 1 })) && !decodable(track({ duration: 0 }), MAX_DECODE_SECONDS + 60) && !decodable(track({ duration: 0, src: { size: 900e6 } })));
t('a stem set needs a mix or stems', decodable({ kind: 'render', mix: {}, stems: [] }) && decodable({ kind: 'render', mix: null, stems: [{}] }) && !decodable({ kind: 'render', mix: null, stems: [] }) && !decodable(null));
console.log(bad ? `\n${bad} FAILED` : '\nall mixer tests pass'); process.exit(bad ? 1 : 0);
