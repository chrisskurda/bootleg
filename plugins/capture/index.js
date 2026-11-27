// Capture plugin (docs/plugins/CAPTURE.md): the Record page. Record a side of a record or tape from an audio input, see
// where the tracks are, adjust the splits, name the tracks (by hand or from a metadata lookup), and save them as FLAC
// into the library with their provenance. Recording, analysis and saving are native (plugins/capture/native).
import { SOURCES, fmtT, tracksFrom, addSplit, removeSplit, moveSplit, sideQuery, fillFrom, importInfo } from './capture-logic.js';

export function activate(api) {
  if (!api.native) return { status: () => 'Needs the desktop app with the capture plugin built in.' };
  const S = (k, d) => api.settings.get(k, d), set = (k, v) => api.settings.set(k, v);
  let devices = [], kept = [], backend = '', root = null, msg = '', busy = '';
  let rec = null, levels = null;              // recording: { job, started }, levels: the latest Levels event
  let side = null;                            // the recording being edited: { path, analysis, splits, start, end, tracks }
  let meta = S('meta', { album: '', albumArtist: '', year: '', genre: '', disc: '' }), first = 1, cands = null, saved = null;
  const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'style') e.style.cssText = v; else if (k in e) e[k] = v; else e.setAttribute(k, v); } for (const c of kids.flat()) if (c != null && c !== false && c !== '') e.append(c.nodeType ? c : String(c)); return e; };
  const call = async (f, label) => { busy = label; msg = ''; paint(); try { return await f(); } catch (e) { msg = String(e.message || e); } finally { busy = ''; paint(); } };

  async function refresh() {
    try { backend = (await api.native.invoke('backend_info')).backend; devices = await api.native.invoke('devices'); kept = await api.native.invoke('recordings'); } catch (e) { msg = String(e.message || e); }
    if (!devices.some(d => d.id === S('device'))) set('device', (devices.find(d => d.default) || devices[0])?.id || '');
    paint();
  }
  function startRecording() {
    const dev = devices.find(d => d.id === S('device')); if (!dev) { msg = 'Choose an input first.'; paint(); return; }
    levels = null; saved = null; msg = '';
    const job = api.native.job('record', { device: dev.id, rate: +S('rate', 0) || 0, name: S('label', 'side-a') }, ev => { if (ev.type === 'event') { levels = ev.data; paintMeters(); } });
    rec = { job, started: Date.now() }; paint();
    job.done.then(async r => { rec = null; kept = await api.native.invoke('recordings').catch(() => kept); await open(r.path); if (r.ended !== 'finished') msg = `Recording stopped: ${r.ended}. What was recorded is kept.`; paint(); },
      e => { rec = null; msg = e.cancelled ? 'Recording thrown away.' : String(e.message || e); paint(); });
  }
  async function open(path) {
    await call(async () => {
      const a = await api.native.invoke('analyze', { path, points: 1600 });
      side = { path, analysis: a, start: a.start, end: a.end, splits: a.splits.slice(), tracks: [] }; side.tracks = tracksFrom(side, first); cands = null; saved = null;
    }, 'Looking for the tracks…');
  }
  const retrack = () => { side.tracks = tracksFrom(side, first, side.tracks); paint(); };
  async function lookup() {
    await call(async () => { const { candidates, errors } = await api.metadata.lookup(sideQuery(meta, side.tracks)); cands = { list: candidates.filter(c => c.tracks?.length).slice(0, 6), errors }; }, 'Looking it up…');
  }
  function use(c) {
    const r = fillFrom(side.tracks, c); side.tracks = r.tracks; first = side.tracks[0]?.number || first;
    meta = { ...meta, album: meta.album || c.tags?.album || c.title, albumArtist: meta.albumArtist || c.tags?.albumArtist || c.artist, year: meta.year || String(c.tags?.year || ''), genre: meta.genre || c.tags?.genre || '' }; set('meta', meta); cands = null; paint();
  }
  async function saveTracks() {
    let dest = S('dest', '') || api.library.roots()[0] || ''; if (!dest) { dest = await api.dialog.folder({ title: 'Where to save the tracks' }); if (!dest) return; set('dest', dest); }
    const request = { recording: side.path, dest, template: S('template', '{albumartist}/{album}/{track} {title}'), album: meta.album, albumArtist: meta.albumArtist, year: meta.year, genre: meta.genre, disc: +meta.disc || 0,
      tracks: side.tracks.map(t => ({ start: t.start, end: t.end, number: t.number, title: t.title, artist: t.artist })), bits: +S('bits', 24), declick: S('declick', true), source: S('source', 'vinyl'), device: S('deck', '') };
    await call(async () => {
      const job = api.native.job('save', { request }, ev => { if (ev.type === 'progress') { busy = ev.text; paintBusy(); } });
      const out = await job.done, dev = devices.find(d => d.id === S('device'));
      await api.library.import(out.map(s => s.path), importInfo(out, { source: S('source', 'vinyl'), deck: S('deck', ''), input: dev?.name || '', meta }));
      saved = out;
    }, 'Saving…');
  }
  async function discard(path) { await call(async () => { await api.native.invoke('discard', { path }); if (side?.path === path) side = null; kept = await api.native.invoke('recordings'); }, 'Deleting…'); }

  // ── drawing ─────────────────────────────────────────────────────────────────────────────────────────────────────
  function paintMeters() {
    const m = root?.querySelector('.cpmeters'); if (!m || !levels) return;
    m.replaceChildren(...levels.peakDb.map((p, c) => el('div', { class: 'cpmeter' }, el('span', { class: 'muted small' }, c ? 'R' : 'L'), el('div', { class: 'cpbar' }, el('i', { style: `width:${Math.max(0, (p + 60) / 60 * 100)}%` }), el('b', { style: `left:${Math.max(0, (levels.rmsDb[c] + 60) / 60 * 100)}%` })), el('span', { class: 'small' + (p > -1 ? ' cpclip' : '') }, `${p.toFixed(1)} dB`))),
      el('div', { class: 'small muted' }, `${fmtT(levels.seconds)} recorded${levels.clipped ? ` · ${levels.clipped} clipped samples: turn the input down` : ''}`));
  }
  function paintBusy() { const b = root?.querySelector('.cpbusy'); if (b) b.textContent = busy; }
  function wave() {
    const a = side.analysis, cv = el('canvas', { class: 'cpwave', width: 1600, height: 140, title: 'Click to add a split' }), g = cv.getContext('2d'), W = cv.width, H = cv.height, x = t => t / a.seconds * W;
    g.fillStyle = 'rgba(255,255,255,.05)'; g.fillRect(0, 0, x(side.start), H); g.fillRect(x(side.end), 0, W - x(side.end), H);
    g.fillStyle = getComputedStyle(document.body).getPropertyValue('--accent') || '#7aa2ff';
    a.overview.forEach((p, i) => { const h = Math.max(1, p * H * 0.95); g.fillRect(i / a.overview.length * W, (H - h) / 2, Math.max(1, W / a.overview.length), h); });
    g.fillStyle = '#ffc65c'; g.font = '20px system-ui';
    side.tracks.forEach((t, i) => { g.fillRect(x(t.start) - 1, 0, 2, H); g.fillText(String(t.number), x(t.start) + 4, 22); if (i === side.tracks.length - 1) g.fillRect(x(t.end) - 1, 0, 2, H); });
    cv.onclick = e => { const r = cv.getBoundingClientRect(), t = (e.clientX - r.left) / r.width * a.seconds; side.splits = addSplit(side.splits, t, side.start, side.end); retrack(); };
    return cv;
  }
  const field = (label, key) => el('label', { class: 'cpf' }, el('span', {}, label), el('input', { value: meta[key] || '', onchange: e => { meta = { ...meta, [key]: e.target.value }; set('meta', meta); } }));
  function paint() {
    if (!root) return;
    const dev = devices.find(d => d.id === S('device')), src = S('source', 'vinyl');
    root.replaceChildren(el('div', { class: 'cppage' },
      el('div', { class: 'cphead' }, el('h3', {}, 'Record'), backend === 'sim' ? el('span', { class: 'pbadge experimental' }, 'simulated input') : '', busy ? el('span', { class: 'cpbusy muted small' }, busy) : ''),
      msg ? el('p', { class: 'err' }, msg) : '',
      // 1. the input
      el('div', { class: 'cpgrid' },
        el('label', { class: 'cpf' }, el('span', {}, 'Recording from'), el('select', { disabled: !!rec, onchange: e => { set('source', e.target.value); paint(); } }, ...Object.entries(SOURCES).map(([k, s]) => el('option', { value: k, selected: k === src }, s.label)))),
        el('label', { class: 'cpf' }, el('span', {}, SOURCES[src].deck), el('input', { value: S('deck', ''), placeholder: 'for the provenance, e.g. Technics SL-1200 / AT-VM95E', onchange: e => set('deck', e.target.value) })),
        el('label', { class: 'cpf' }, el('span', {}, 'Input'), el('select', { disabled: !!rec, onchange: e => { set('device', e.target.value); set('rate', 0); paint(); } }, ...(devices.length ? devices.map(d => el('option', { value: d.id, selected: d.id === S('device') }, d.name + (d.default ? ' (default)' : ''))) : [el('option', {}, 'No audio inputs found')]))),
        el('label', { class: 'cpf' }, el('span', {}, 'Sample rate'), el('select', { disabled: !!rec, onchange: e => set('rate', +e.target.value) }, el('option', { value: 0 }, `The input's own (${dev ? dev.defaultRate / 1000 + ' kHz' : '?'})`), ...(dev?.rates || []).map(r => el('option', { value: r, selected: r === +S('rate', 0) }, `${r / 1000} kHz`)))),
        el('label', { class: 'cpf' }, el('span', {}, 'Name'), el('input', { value: S('label', 'side-a'), disabled: !!rec, onchange: e => set('label', e.target.value) }))),
      rec ? el('div', { class: 'cprec' }, el('div', { class: 'cpmeters' }, el('span', { class: 'muted small' }, 'Waiting for sound…')), el('div', { class: 'cpbtns' }, el('button', { class: 'btn primary', onclick: async () => api.native.invoke('finish', { job: await rec.job.id }) }, 'Finish side'), el('button', { class: 'btn', onclick: () => rec.job.cancel() }, 'Throw away')))
        : el('div', { class: 'cpbtns' }, el('button', { class: 'btn primary', disabled: !dev || !!busy, onclick: startRecording }, '● Record'), el('span', { class: 'muted small' }, 'Play the side through, then Finish. Set the level so the loudest parts peak around −6 dB; clipping can’t be undone.')),
      kept.length && !rec ? el('details', { class: 'cpkept', open: !side }, el('summary', {}, `Recordings kept (${kept.length})`), ...kept.map(k => el('div', { class: 'cprow' }, el('span', {}, k.path.split(/[\\/]/).pop()), el('span', { class: 'muted small' }, `${fmtT(k.seconds)} · ${(k.bytes / 1e6).toFixed(0)} MB`), el('button', { class: 'link', onclick: () => open(k.path) }, 'open'), el('button', { class: 'link', onclick: () => discard(k.path) }, 'delete')))) : '',
      // 2. the tracks
      side ? el('div', { class: 'cpside' },
        el('h4', {}, `${side.path.split(/[\\/]/).pop()} · ${fmtT(side.analysis.seconds)} · ${side.analysis.rate / 1000} kHz`),
        wave(),
        el('div', { class: 'muted small' }, `Click the waveform to add a split. Quiet below ${side.analysis.thresholdDb.toFixed(0)} dBFS (surface noise ${side.analysis.floorDb.toFixed(0)}).`),
        el('div', { class: 'cpgrid' }, field('Album', 'album'), field('Album artist', 'albumArtist'), field('Year', 'year'), field('Genre', 'genre'), field('Disc', 'disc'),
          el('label', { class: 'cpf' }, el('span', {}, 'First track number'), el('input', { type: 'number', min: 1, value: first, onchange: e => { first = Math.max(1, +e.target.value || 1); retrack(); } }))),
        el('div', { class: 'cpbtns' }, api.metadata.providers.length ? el('button', { class: 'btn', disabled: !!busy, onclick: lookup }, 'Find the titles online…') : el('span', { class: 'muted small' }, 'Turn on MusicBrainz in Settings → Plugins to fill in titles from a release.')),
        cands ? el('div', { class: 'cpcands' }, ...cands.errors.map(e => el('div', { class: 'err small' }, `${e.provider}: ${e.message}`)), cands.list.length ? '' : el('div', { class: 'muted small' }, 'Nothing found. Type the album and artist above and try again.'),
          ...cands.list.map(c => el('div', { class: 'cprow' }, el('b', {}, c.title), el('span', { class: 'muted small' }, `${c.artist} · ${c.summary || ''}`), el('button', { class: 'btn', onclick: () => use(c) }, 'Use these titles')))) : '',
        el('table', { class: 'cptracks' }, ...side.tracks.map((t, i) => el('tr', {},
          el('td', { class: 'muted' }, String(t.number)), el('td', {}, el('input', { value: t.title, placeholder: `Track ${t.number}`, onchange: e => { t.title = e.target.value; } })),
          el('td', { class: 'muted small' }, `${fmtT(t.start)} – ${fmtT(t.end)} (${fmtT(t.end - t.start)})`),
          el('td', {}, i ? el('span', {}, el('button', { class: 'mini', title: 'Move this split back 0.5 s', onclick: () => { side.splits = moveSplit(side.splits, i - 1, -0.5, side.start, side.end); retrack(); } }, '◂'), el('button', { class: 'mini', title: 'Move this split on 0.5 s', onclick: () => { side.splits = moveSplit(side.splits, i - 1, 0.5, side.start, side.end); retrack(); } }, '▸'), el('button', { class: 'mini', title: 'Join with the track before', onclick: () => { side.splits = removeSplit(side.splits, i - 1); retrack(); } }, '⨯')) : '')))),
        el('div', { class: 'cpgrid' },
          el('label', { class: 'cprow' }, el('input', { type: 'checkbox', checked: S('declick', true), onchange: e => set('declick', e.target.checked) }), 'Remove clicks'),
          el('label', { class: 'cpf' }, el('span', {}, 'Bit depth'), el('select', { onchange: e => set('bits', +e.target.value) }, el('option', { value: 24, selected: +S('bits', 24) === 24 }, '24-bit FLAC'), el('option', { value: 16, selected: +S('bits', 24) === 16 }, '16-bit FLAC (dithered)'))),
          el('label', { class: 'cpf' }, el('span', {}, 'Save into'), el('span', { class: 'cprow' }, el('span', { class: 'small' }, S('dest', '') || api.library.roots()[0] || 'choose…'), el('button', { class: 'link', onclick: async () => { const f = await api.dialog.folder({ title: 'Where to save the tracks' }); if (f) { set('dest', f); paint(); } } }, 'change')))),
        el('div', { class: 'cpbtns' }, el('button', { class: 'btn primary', disabled: !!busy || !side.tracks.length, onclick: saveTracks }, `Save ${side.tracks.length} track${side.tracks.length === 1 ? '' : 's'}`)),
        saved ? el('div', { class: 'cpsaved' }, el('p', {}, `Saved ${saved.length} tracks into the library${saved.some(s => s.clicks) ? `, ${saved.reduce((n, s) => n + s.clicks, 0)} clicks removed` : ''}.`), el('button', { class: 'btn', onclick: () => discard(side.path) }, 'Delete the raw recording'), el('span', { class: 'muted small' }, ' (keep it if you may want to save the tracks again differently)')) : '') : ''));
    paintMeters();
  }
  const remove = api.ui.addView({ title: 'Record', mount(r) { r.append(el('style', {}, CSS)); root = el('div'); r.append(root); paint(); refresh(); return () => { root = null; }; } });
  return {
    stop() { rec?.job.cancel(); remove(); },
    status: () => (rec ? 'recording…' : devices.length ? `${devices.length} input${devices.length === 1 ? '' : 's'}` : ''),
    _test: { refresh, startRecording, open, saveTracks, get side() { return side; }, get rec() { return rec; }, get saved() { return saved; }, get levels() { return levels; } },
  };
}

const CSS = `
.cppage { max-width: 1000px; padding: 14px 4px 40px; display: grid; gap: 12px; }
.cphead { display: flex; gap: 10px; align-items: center; } .cphead h3 { margin: 0; }
.cpgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px 14px; align-items: end; }
.cpf { display: grid; gap: 4px; } .cpf > span { font-size: 12px; color: var(--muted); } .cpf input, .cpf select { width: 100%; box-sizing: border-box; }
.cpbtns, .cprow { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.cprec { display: grid; gap: 10px; padding: 12px; border-radius: 10px; background: var(--panel2); }
.cpmeters { display: grid; gap: 6px; } .cpmeter { display: grid; grid-template-columns: 16px 1fr 70px; gap: 8px; align-items: center; }
.cpbar { position: relative; height: 10px; border-radius: 5px; background: #ffffff10; overflow: hidden; } .cpbar > i { display: block; height: 100%; background: linear-gradient(90deg, #5fd28a 70%, #ffc65c 90%, #ff6b6b); }
.cpbar > b { position: absolute; top: 0; width: 2px; height: 100%; background: #fff8; } .cpclip { color: #ff6b6b; font-weight: 700; }
.cpwave { width: 100%; height: 140px; border-radius: 8px; background: var(--panel2); cursor: crosshair; }
.cptracks { width: 100%; border-collapse: collapse; } .cptracks td { padding: 3px 6px; border-bottom: 1px solid var(--line); } .cptracks td input { width: 100%; box-sizing: border-box; }
.cpside, .cpcands { display: grid; gap: 10px; } .cpkept summary { cursor: pointer; }
`;
