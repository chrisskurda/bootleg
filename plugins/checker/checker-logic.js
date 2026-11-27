// Library checker: what the measurements mean (findings, with their tags and wording), how tracks are put together into
// discs for AccurateRip, and what goes into the library. No page, no native calls; tested in checker.test.mjs.
// The thresholds live here, not in the native part, so they can be tuned with a plugin update.

export const TAG = { damaged: 'check:damaged', truncated: 'check:truncated', md5: 'check:changed', lossy: 'check:lossy-source', upsampled: 'check:upsampled', padded: 'check:padded-bits', clipping: 'check:clipping' };
export const ALL_TAGS = Object.values(TAG);
export const LABEL = {
  damaged: 'Damaged', truncated: 'Cut short', md5: 'Audio changed', lossy: 'Made from a lossy file', upsampled: 'Upsampled', padded: 'Padded bit depth', clipping: 'Clipping',
  verified: 'AccurateRip verified', suspect: 'Does not match AccurateRip', unreadable: 'Could not be read',
};
const LOSSLESS_EXT = /\.(flac|wav|aiff?|m4a|alac)$/i;
export const fmtT = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const khz = hz => `${(hz / 1000).toFixed(1)} kHz`;

/// The bitrate a lossy encoder's lowpass suggests (LAME / common AAC defaults at 44.1/48 kHz).
export function lossyGuess(hz) {
  if (hz < 15_000) return 'a low-bitrate lossy file (96 kbps or less)';
  if (hz < 16_800) return 'a lossy file of about 128 kbps';
  if (hz < 18_800) return 'a lossy file of about 160–192 kbps';
  if (hz < 19_600) return 'a lossy file of about 224–256 kbps';
  return 'a lossy file of about 320 kbps (or VBR V0)';
}

/// One file's findings: [{ code, tag, level: 'bad' | 'warn' | 'info', text }]. `c` is the native FileCheck.
export function findings(c) {
  const out = [], m = c.measures || {}, sp = m.spectrum;
  const dmg = (c.damage || []).filter(d => !/ends early/.test(d.detail));
  if (dmg.length) out.push({ code: 'damaged', tag: TAG.damaged, level: 'bad', text: `Damaged: ${dmg.length === 1 ? 'one stretch' : `${dmg.length} stretches`} could not be decoded (${dmg.slice(0, 4).map(d => `${fmtT(d.start)}–${fmtT(d.end)}`).join(', ')}${dmg.length > 4 ? ', …' : ''}). ${c.format === 'flac' ? 'Decoding stops at the first broken frame; `flac -F` can often recover the rest.' : ''}`.trim() });
  if (c.truncated) out.push({ code: 'truncated', tag: TAG.truncated, level: 'bad', text: `Cut short: the file ends at ${fmtT(c.seconds)} but says it is ${fmtT(c.expectedSeconds)} long. A download or copy probably stopped early.` });
  if (c.md5 === 'mismatch' && !dmg.length && !c.truncated) out.push({ code: 'md5', tag: TAG.md5, level: 'bad', text: 'The audio no longer matches the checksum the encoder stored in the file: something has changed it since it was made.' });
  if (c.lossless && sp?.steep && sp.cutoffHz < 20_000 && c.rate <= 96_000) out.push({ code: 'lossy', tag: TAG.lossy, level: 'warn', text: `Probably made from ${lossyGuess(sp.cutoffHz)}: nothing above ${khz(sp.cutoffHz)}, cut off sharply (${Math.round(sp.dropDb)} dB). A real lossless copy goes up to about 20–22 kHz. (Some old masters are filtered like this too.)` });
  else if (c.lossless && c.rate >= 88_200 && sp?.steep && sp.cutoffHz <= 24_500) out.push({ code: 'upsampled', tag: TAG.upsampled, level: 'warn', text: `Upsampled: a ${c.rate / 1000} kHz file with nothing above ${khz(sp.cutoffHz)}, so it was probably made from a 44.1 or 48 kHz source.` });
  if (c.lossless && m.usedBits > 0 && c.bits > m.usedBits && c.bits >= 20) out.push({ code: 'padded', tag: TAG.padded, level: 'warn', text: `Padded: a ${c.bits}-bit file that only uses ${m.usedBits} bits, so it holds ${m.usedBits}-bit audio.` });
  const clipLimit = Math.max(20, (c.seconds || 0) / 10);
  if (m.clipRuns >= clipLimit) out.push({ code: 'clipping', tag: TAG.clipping, level: 'info', text: `Clipping: the waveform is flattened at full scale in ${m.clipRuns.toLocaleString()} places (${m.clipSamples.toLocaleString()} samples)${m.dr != null ? `; DR ${Math.round(m.dr)}` : ''}. This is usually in the master, not your copy.` });
  return out;
}

/// The AccurateRip result for one track of a checked album: a finding, or null when there is nothing to say.
export function arFinding(album, index) {
  if (album.state !== 'checked') return null;
  const t = album.tracks[index]; if (!t) return null;
  if (t.matched) return { code: 'verified', tag: 'rip:verified', level: 'ok', text: `AccurateRip: verified (${t.matched}, confidence ${t.confidence}).` };
  return { code: 'suspect', tag: 'rip:suspect', level: 'warn', text: `AccurateRip: does not match the ${t.total} submission${t.total === 1 ? '' : 's'} for this disc. The rip may have errors, or it is a different pressing (or the drive offset was wrong).` };
}

/// Discs for AccurateRip: lossless tracks grouped by folder + album + disc, in track order, when the numbers run 1…n
/// without a gap (otherwise the disc's layout can't be known). Returns [[path…]].
export function albums(tracks) {
  const by = new Map();
  for (const t of tracks) {
    const p = t.src?.path; if (!p || !LOSSLESS_EXT.test(p) || !t.album || !(t.track > 0)) continue;
    const k = [p.replace(/[\\/][^\\/]*$/, ''), t.albumArtist || t.artist || '', t.album, t.disc || 1].join('\u0000');
    (by.get(k) || by.set(k, []).get(k)).push(t);
  }
  const out = [];
  for (const ts of by.values()) {
    ts.sort((a, b) => a.track - b.track);
    if (ts.length >= 1 && ts.every((t, i) => t.track === i + 1)) out.push(ts.map(t => t.src.path));
  }
  return out;
}

/// What goes into the library for one track (api.library.annotate): tags added and removed, the plugin's note, defects.
/// `ar`: the track's AccurateRip finding, or undefined when its album wasn't checked (then rip:* tags are left alone).
/// `error`: the file could not be opened or decoded at all.
export function annotation(c, ar, error) {
  const fs = c ? findings(c) : error ? [{ code: 'unreadable', tag: TAG.damaged, level: 'bad', text: `Could not be read: ${error}.` }] : [], tags = fs.map(f => f.tag), removeTags = ALL_TAGS.filter(t => !tags.includes(t));
  if (ar) { tags.push(ar.tag); removeTags.push(ar.tag === 'rip:verified' ? 'rip:suspect' : 'rip:verified'); }
  const lines = [...fs.map(f => f.text), ...(ar ? [ar.text] : [])];
  const defects = (c?.damage || []).map(d => ({ start: d.start, end: d.end, kind: /ends early/.test(d.detail) ? 'missing' : 'unreadable', confidence: 1, detail: d.detail }));
  return { tags, removeTags, notes: lines.length ? [{ text: `Library check: ${lines.join(' ')}` }] : [], defects };
}
