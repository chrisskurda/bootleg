// The CD plugin's logic that doesn't touch the page: MusicBrainz releases → rip metadata, the AccurateRip drive offset
// list, and what a finished rip writes into the library (provenance, tags, notes, defects). Tested in cd.test.mjs.

/// MusicBrainz web service URL for a disc: by disc id, with the TOC as a fallback (finds releases with a matching TOC
/// whose disc id isn't attached yet). JSON, with everything a rip's tags need.
export function mbDiscUrl(disc) {
  const inc = 'artist-credits+recordings+labels+release-groups+isrcs';
  return `https://musicbrainz.org/ws/2/discid/${encodeURIComponent(disc.musicbrainzId)}?toc=${disc.musicbrainzToc}&cdstubs=no&inc=${inc}&fmt=json`;
}

const credit = ac => (ac || []).map(a => (a.name || a.artist?.name || '') + (a.joinphrase || '')).join('');

/// The medium of `release` that holds this disc (by disc id, else by track count), or null.
export function mediumFor(release, disc) {
  const ms = release.media || [];
  return ms.find(m => (m.discs || []).some(d => d.id === disc.musicbrainzId)) || ms.find(m => (m['track-count'] ?? m.tracks?.length) === disc.toc.tracks.filter(t => t.audio).length) || null;
}

/// Releases for the picker: one row each, most useful facts first.
export function releaseChoices(json, disc) {
  return (json?.releases || []).map(r => {
    const m = mediumFor(r, disc), li = (r['label-info'] || [])[0];
    return { id: r.id, title: r.title, artist: credit(r['artist-credit']), date: r.date || '', country: r.country || '', label: li?.label?.name || '', catalog: li?.['catalog-number'] || '', barcode: r.barcode || '', format: m?.format || '', disc: m?.position || 1, discs: (r.media || []).length, exact: !!m && (m.discs || []).some(d => d.id === disc.musicbrainzId), release: r };
  });
}

/// A chosen release → the Meta the native rip takes (camelCase, see output.rs `Meta`).
export function metaFromRelease(choice, disc) {
  const r = choice.release, m = mediumFor(r, disc) || { tracks: [] }, rg = r['release-group'] || {};
  const albumArtist = credit(r['artist-credit']);
  const audio = disc.toc.tracks.filter(t => t.audio);
  return {
    album: r.title || '', albumArtist, date: r.date || '', genre: '', label: choice.label, catalog: choice.catalog, barcode: r.barcode || '',
    disc: m.position || 1, discs: (r.media || []).length || 1, releaseId: r.id, releaseGroupId: rg.id || '', artistId: r['artist-credit']?.[0]?.artist?.id || '',
    coverJpegBase64: '',
    tracks: (m.tracks || []).map((t, i) => ({ number: audio[i]?.number ?? i + 1, title: t.title || t.recording?.title || '', artist: credit(t['artist-credit'] || t.recording?.['artist-credit']) || albumArtist, recordingId: t.recording?.id || '', trackId: t.id || '' })),
  };
}

/// Blank metadata for a disc nobody has catalogued: "Track 01" … (the user fills in what they know).
export function blankMeta(disc) { return { album: '', albumArtist: '', date: '', genre: '', label: '', catalog: '', barcode: '', disc: 1, discs: 1, releaseId: '', releaseGroupId: '', artistId: '', coverJpegBase64: '', tracks: disc.toc.tracks.filter(t => t.audio).map(t => ({ number: t.number, title: '', artist: '', recordingId: '', trackId: '' })) }; }

/// The read offset of a drive from AccurateRip's drive list (http://www.accuraterip.com/driveoffsets.htm), or null.
/// The page is an HTML table: "VENDOR - MODEL" in one cell, the offset ("+6", "-472", "[Purged]") in the next.
export function findOffset(html, vendor, model) {
  const cells = [...String(html).matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
  const norm = s => s.toUpperCase().replace(/[^A-Z0-9]+/g, '');
  const want = norm(`${vendor}${model}`), wantModel = norm(model);
  for (let i = 0; i < cells.length - 1; i++) {
    const c = norm(cells[i]); if (!c || !(c === want || (wantModel.length >= 4 && c.endsWith(wantModel)))) continue;
    const m = /^([+-]?\d+)$/.exec(cells[i + 1].replace(/\s/g, '')); if (m) return +m[1];
  }
  return null;
}

const TAG = { verified: 'rip:verified', secure: 'rip:secure', suspect: 'rip:suspect', damaged: 'rip:damaged' };
/// What a finished rip writes on each track in the library (plugin spec §6 import/annotate).
export function annotations(result, drive, today = new Date().toISOString().slice(0, 10)) {
  const by = new Map(result.tracks.map(t => [t.path, t]));
  return path => {
    const t = by.get(path); if (!t) return {};
    const ar = t.accuraterip, arText = ar.matched ? `AccurateRip verified (${ar.matched}, confidence ${ar.confidence})` : ar.total ? 'did not match AccurateRip' : 'not in AccurateRip';
    const notes = [];
    if (t.status === 'damaged') notes.push({ text: `Damaged rip: ${t.unreadable} sector${t.unreadable === 1 ? '' : 's'} unreadable, ${t.uncertain} uncertain. ${t.defects.map(d => `${fmtT(d.start)}–${fmtT(d.end)} ${d.kind}`).join('; ')}. A re-rip after cleaning the disc, or in another drive, may recover it.` });
    if (t.status === 'suspect') notes.push({ text: 'Every sector read consistently, but the result does not match AccurateRip. Check the drive\'s read offset, or this may be a different pressing.' });
    return {
      tags: [TAG[t.status]].filter(Boolean),
      provenance: { kind: 'cd-rip', date: today, device: [drive?.vendor, drive?.model].filter(Boolean).join(' '), source: arText, note: `bootleg CD, copy CRC ${t.crc32}${t.isrc ? ', ISRC ' + t.isrc : ''}` },
      notes, defects: t.defects,
    };
  };
}
export const fmtT = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
