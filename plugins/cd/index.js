// CD plugin (docs/plugins/CD.md): the Rip page. The reading, verification and encoding happen in the native part
// (plugins/cd/native, `api.native`); this page picks the drive and release, sets the output, runs the rip as a job,
// and puts the result in the library with its provenance, tags and any damage.
import { mbDiscUrl, releaseChoices, metaFromRelease, blankMeta, findOffset, annotations, fmtT } from './cd-logic.js';

const FILL = { keep: 'Keep the best reads', silence: 'Silence', interpolate: 'Interpolate' };
const STATUS = { verified: ['✓', 'Accurate', 'ok'], secure: ['✓', 'Secure (not in AccurateRip)', 'ok'], suspect: ['?', 'No AccurateRip match', 'warn'], damaged: ['⚠', 'Damaged', 'bad'] };

export function activate(api) {
  if (!api.native) return { status: () => 'Needs the desktop app with the CD plugin built in.' };
  const S = (k, d) => api.settings.get(k, d), set = (k, v) => api.settings.set(k, v);
  let drives = [], driveId = S('drive', ''), disc = null, choices = [], meta = null, job = null, result = null, status = 'idle', root = null, backend = '';
  const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'style') e.style.cssText = v; else if (k in e && k !== 'list') e[k] = v; else e.setAttribute(k, v); } for (const c of kids.flat()) if (c != null && c !== false && c !== '') e.append(c.nodeType ? c : String(c)); return e; };
  const drive = () => drives.find(d => d.id === driveId);
  const offsets = () => S('offsets', {}), driveKey = d => d ? `${d.vendor} ${d.model}`.trim() : '';

  async function refresh() {
    try { backend = (await api.native.invoke('backend_info')).backend; drives = await api.native.invoke('drives'); } catch (e) { drives = []; status = String(e); }
    if (!drives.some(d => d.id === driveId)) driveId = drives.find(d => d.has_disc)?.id || drives[0]?.id || '';
    paint(); if (driveId && drive()?.has_disc) await readDisc(); else { disc = null; paint(); }
  }
  async function readDisc() {
    status = 'Reading the disc…'; disc = null; choices = []; meta = null; result = null; paint();
    try { disc = await api.native.invoke('disc', { drive: driveId }); meta = blankMeta(disc); status = 'idle'; paint(); lookup(); }
    catch (e) { status = String(e); paint(); }
  }
  async function lookup() {
    if (!disc) return; status = 'Looking the disc up on MusicBrainz…'; paint();
    try {
      const r = await api.net.fetch(mbDiscUrl(disc), { headers: { Accept: 'application/json' } });
      choices = r.ok ? releaseChoices(await r.json(), disc) : [];
      if (choices.length) await pick(choices.find(c => c.exact) || choices[0]); status = choices.length ? 'idle' : 'Not on MusicBrainz: fill in what you know.';
    } catch (e) { status = `MusicBrainz lookup failed (${e.message || e}); fill in what you know.`; }
    paint();
  }
  async function pick(c) {
    meta = metaFromRelease(c, disc); paint();
    try { const r = await api.net.fetch(`https://coverartarchive.org/release/${c.id}/front-500`); if (r.ok) { const b = new Uint8Array(await r.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); meta.coverJpegBase64 = btoa(s); paint(); } } catch { /* no cover */ }
  }
  async function lookupOffset() {
    const d = drive(); if (!d) return; status = 'Looking up the read offset…'; paint();
    try { const html = await (await api.net.fetch('http://www.accuraterip.com/driveoffsets.htm')).text(); const o = findOffset(html, d.vendor, d.model); if (o == null) status = `${driveKey(d)} is not in AccurateRip's drive list; enter its offset if you know it.`; else { set('offsets', { ...offsets(), [driveKey(d)]: o }); status = `Read offset ${o > 0 ? '+' : ''}${o} (AccurateRip drive list).`; } }
    catch (e) { status = `Could not get the drive list: ${e.message || e}`; }
    paint();
  }
  async function probe() {
    status = 'Checking the drive…'; paint();
    try { const p = await api.native.invoke('probe', { drive: driveId }); result = { probe: p }; status = 'idle'; } catch (e) { status = String(e); }
    paint();
  }
  async function rip() {
    let dest = S('dest', '') || api.library.roots?.()[0] || '';
    if (!dest) { dest = await api.dialog.folder({ title: 'Where should rips go?' }); if (!dest) return; set('dest', dest); }
    const d = drive(), sel = [...root.querySelectorAll('input[data-track]:checked')].map(x => +x.dataset.track);
    const request = {
      tracks: sel, dest, template: S('template', '{albumartist}/{album}/{track} {title}'), format: S('format', 'flac'), meta,
      secure: { offset: offsets()[driveKey(d)] ?? 0, use_c2: S('useC2', false) && !!disc.capabilities.c2, max_rounds: +S('rounds', 20), cache_defeat: +S('cacheDefeat', 1400) },
      fill: { uncertain: S('fillUncertain', 'keep'), unreadable_short: S('fillShort', 'interpolate'), unreadable_long: S('fillLong', 'silence'), short_ms: +S('shortMs', 30) },
    };
    result = null; status = 'ripping'; const log = []; const prog = { f: 0, text: 'Starting…' }; paint();
    job = api.native.job('rip', { drive: driveId, request }, ev => {
      if (ev.type === 'progress') { prog.f = ev.fraction; prog.text = ev.text; paintProgress(prog); }
      if (ev.type === 'log') { log.push(ev.line); paintLog(log); }
    });
    try {
      const r = await job.done; result = { rip: r, log };
      status = 'Adding to the library…'; paint();
      await api.library.import(r.tracks.map(t => t.path), annotations(r, d));
      status = 'idle'; api.toast(`Ripped: ${r.summary}`, r.tracks.some(t => t.status === 'damaged'));
    } catch (e) { status = e.cancelled ? 'Cancelled.' : `Rip failed: ${e.message || e}`; result = result || { log }; }
    job = null; paint();
  }

  // ---- the page
  function paintProgress(p) { const bar = root?.querySelector('.cdbar > i'), t = root?.querySelector('.cdprog'); if (bar) bar.style.width = (p.f * 100).toFixed(1) + '%'; if (t) t.textContent = p.text; }
  function paintLog(lines) { const l = root?.querySelector('.cdlog'); if (l) { l.textContent = lines.slice(-200).join('\n'); l.scrollTop = l.scrollHeight; } }
  const field = (label, input, hint) => el('label', { class: 'cdf' }, el('span', {}, label), input, hint ? el('small', { class: 'muted' }, hint) : '');
  const sel = (key, opts, def, onchange) => el('select', { onchange: e => { set(key, e.target.value); onchange?.(); } }, ...Object.entries(opts).map(([v, t]) => el('option', { value: v, selected: S(key, def) === v }, t)));
  const txt = (obj, key, ph = '') => el('input', { value: obj[key] ?? '', placeholder: ph, oninput: e => { obj[key] = e.target.value; } });

  function paint() {
    if (!root) return; const d = drive(), busy = !!job;
    const head = el('div', { class: 'cdhead' },
      el('h3', {}, 'CD'),
      drives.length ? el('select', { disabled: busy, onchange: e => { driveId = e.target.value; set('drive', driveId); readDisc(); } }, ...drives.map(x => el('option', { value: x.id, selected: x.id === driveId }, `${x.vendor} ${x.model}${x.has_disc ? '' : ' (empty)'}`))) : el('span', { class: 'muted' }, backend === 'sim' ? 'No simulated discs (BOOTLEG_CD_SIM)' : 'No CD drive found — connect one and refresh.'),
      el('button', { class: 'btn', disabled: busy, onclick: refresh }, 'Refresh'),
      d ? el('button', { class: 'btn', disabled: busy || !d.has_disc, onclick: probe, title: 'Checks what this drive can do on this Mac: C2 error pointers, subchannel, speed control, offsets.' }, 'Check drive') : '',
      backend ? el('span', { class: 'muted small' }, `backend: ${backend}`) : '');
    const msg = status !== 'idle' && status !== 'ripping' ? el('p', { class: 'cdmsg' }, status) : '';
    const parts = [head, msg];
    if (result?.probe) parts.push(probeView(result.probe));
    if (disc) parts.push(discView(d, busy));
    if (busy || status === 'ripping') parts.push(el('div', { class: 'cdrun' }, el('div', { class: 'cdbar' }, el('i')), el('div', { class: 'cdprog muted' }, 'Starting…'), el('button', { class: 'btn', onclick: () => job?.cancel() }, 'Cancel'), el('pre', { class: 'cdlog' })));
    if (result?.rip) parts.push(resultView(result.rip));
    else if (result?.log?.length && !busy) parts.push(el('pre', { class: 'cdlog' }, result.log.join('\n')));
    root.replaceChildren(el('div', { class: 'cdpage' }, ...parts));
  }

  function discView(d, busy) {
    const audio = disc.toc.tracks.filter(t => t.audio), secs = n => disc.seconds[disc.toc.tracks.findIndex(t => t.number === n)] || 0;
    const total = audio.reduce((a, t) => a + secs(t.number), 0), off = offsets()[driveKey(d)];
    const picker = choices.length > 1 ? field('Release', el('select', { disabled: busy, onchange: e => pick(choices[+e.target.value]) }, ...choices.map((c, i) => el('option', { value: i, selected: meta?.releaseId === c.id }, [c.artist, c.title, [c.date, c.country, c.label, c.catalog, c.format, c.discs > 1 ? `disc ${c.disc}/${c.discs}` : ''].filter(Boolean).join(' · ')].join(' — ') + (c.exact ? '' : ' (TOC match)'))))) : '';
    const cover = meta?.coverJpegBase64 ? el('img', { class: 'cdcover', src: 'data:image/jpeg;base64,' + meta.coverJpegBase64, alt: '' }) : el('div', { class: 'cdcover ph' }, '◎');
    const rows = audio.map(t => { const tm = meta.tracks.find(x => x.number === t.number) || (meta.tracks[meta.tracks.length] = { number: t.number, title: '', artist: '' });
      return el('tr', {}, el('td', {}, el('input', { type: 'checkbox', checked: true, 'data-track': t.number, disabled: busy })), el('td', { class: 'mono' }, String(t.number).padStart(2, '0')), el('td', {}, txt(tm, 'title', `Track ${String(t.number).padStart(2, '0')}`)), el('td', {}, txt(tm, 'artist', meta.albumArtist || 'Artist')), el('td', { class: 'mono muted' }, fmtT(secs(t.number)).replace(/\.\d$/, ''))); });
    return el('div', { class: 'cddisc' },
      el('div', { class: 'cdtop' }, cover, el('div', { class: 'cdmeta' },
        el('div', { class: 'muted small' }, `${audio.length} tracks · ${fmtT(total).replace(/\.\d$/, '')}${disc.toc.tracks.length > audio.length ? ' · Enhanced CD (data track skipped)' : ''}${disc.mcn ? ' · barcode ' + disc.mcn : ''} · MusicBrainz ${disc.musicbrainzId}`),
        picker,
        el('div', { class: 'cdgrid' }, field('Album', txt(meta, 'album')), field('Album artist', txt(meta, 'albumArtist')), field('Date', txt(meta, 'date', 'YYYY-MM-DD')), field('Genre', txt(meta, 'genre'))),
        el('div', {}, el('button', { class: 'btn', disabled: busy, onclick: lookup }, 'Look up again'), ' ', meta.releaseId ? el('a', { href: `https://musicbrainz.org/release/${meta.releaseId}`, target: '_blank', class: 'small' }, 'release on MusicBrainz') : el('a', { href: `https://musicbrainz.org/cdtoc/attach?toc=${disc.musicbrainzToc}`, target: '_blank', class: 'small' }, 'add this disc to MusicBrainz')))),
      el('table', { class: 'cdtracks' }, el('tbody', {}, ...rows)),
      el('details', { class: 'cdopts', open: S('optsOpen', false), ontoggle: e => set('optsOpen', e.target.open) }, el('summary', {}, 'Output and reading'),
        el('div', { class: 'cdgrid' },
          field('Folder', el('span', { class: 'cdrow' }, el('input', { value: S('dest', '') || api.library.roots?.()[0] || '', readOnly: true }), el('button', { class: 'btn', onclick: async () => { const p = await api.dialog.folder({ title: 'Where should rips go?' }); if (p) { set('dest', p); paint(); } } }, 'Choose…'))),
          field('File names', el('input', { value: S('template', '{albumartist}/{album}/{track} {title}'), onchange: e => set('template', e.target.value) }), '{albumartist} {artist} {album} {title} {track} {disc} {year} {date} {genre}'),
          field('Format', sel('format', { flac: 'FLAC (lossless, verified)', wav: 'WAV', aiff: 'AIFF' }, 'flac')),
          field('Read offset', el('span', { class: 'cdrow' }, el('input', { type: 'number', value: off ?? '', placeholder: 'unknown (0)', style: 'width:7em', onchange: e => set('offsets', { ...offsets(), [driveKey(d)]: +e.target.value }) }), el('button', { class: 'btn', onclick: lookupOffset }, 'Look up')), 'Samples, for this drive model. AccurateRip only verifies rips made with the right offset.'),
          field('C2 error pointers', el('input', { type: 'checkbox', checked: S('useC2', false), disabled: !disc.capabilities.c2, onchange: e => set('useC2', e.target.checked) }), disc.capabilities.c2 ? 'Use only if "Check drive" shows this drive reports them reliably.' : 'This drive does not report them.'),
          field('Re-read rounds', el('input', { type: 'number', min: 0, max: 200, value: S('rounds', 20), onchange: e => set('rounds', +e.target.value) }), 'For sectors that don\'t read the same twice; the drive slows down as rounds go by.'),
          field('Uncertain audio', sel('fillUncertain', { keep: FILL.keep, silence: FILL.silence, interpolate: FILL.interpolate }, 'keep')),
          field('Short unreadable gaps', el('span', { class: 'cdrow' }, sel('fillShort', { interpolate: FILL.interpolate, silence: FILL.silence, keep: 'Leave as read' }, 'interpolate'), ' up to ', el('input', { type: 'number', min: 0, max: 1000, value: S('shortMs', 30), style: 'width:5em', onchange: e => set('shortMs', +e.target.value) }), ' ms')),
          field('Longer unreadable gaps', sel('fillLong', { silence: FILL.silence, interpolate: FILL.interpolate, keep: 'Leave as read' }, 'silence')))),
      el('div', { class: 'cdgo' }, el('button', { class: 'btn primary', disabled: busy, onclick: rip }, busy ? 'Ripping…' : 'Rip'), off == null ? el('small', { class: 'muted' }, ' No read offset set for this drive: tracks can be secure, but won\'t match AccurateRip.') : ''));
  }

  function resultView(r) {
    return el('div', { class: 'cdresult' }, el('h4', {}, r.summary),
      el('table', { class: 'cdtracks' }, el('tbody', {}, ...r.tracks.map(t => { const [icon, label, cls] = STATUS[t.status];
        return el('tr', {}, el('td', { class: 'cdst ' + cls }, icon), el('td', { class: 'mono' }, String(t.number).padStart(2, '0')), el('td', {}, label, t.defects.length ? el('div', { class: 'small muted' }, t.defects.map(x => `${fmtT(x.start)}–${fmtT(x.end)} ${x.kind} (${x.detail})`).join('; ')) : ''),
          el('td', { class: 'mono small muted' }, t.accuraterip.matched ? `AR ${t.accuraterip.matched} ×${t.accuraterip.confidence}` : t.accuraterip.total ? 'AR mismatch' : 'AR —'), el('td', { class: 'mono small muted' }, `CRC ${t.crc32}`)); }))),
      el('p', { class: 'small muted' }, `Folder: ${r.folder} · log, cue sheet and playlist written beside the files.`));
  }

  function probeView(p) {
    return el('div', { class: 'cdresult' }, el('h4', {}, `Drive check: ${p.drive ? `${p.drive.vendor} ${p.drive.model} (${p.drive.revision})` : ''} — ${p.backend}`),
      el('table', { class: 'cdtracks' }, el('tbody', {}, ...p.steps.map(([name, ok, detail]) => el('tr', {}, el('td', { class: 'cdst ' + (ok ? 'ok' : 'bad') }, ok ? '✓' : '✗'), el('td', {}, name), el('td', { class: 'small muted' }, detail))))),
      el('p', { class: 'small muted' }, 'Please send this to the bootleg CD hardware log (docs/plugins/CD.md) with your macOS version.'));
  }

  const remove = api.ui.addView({ title: 'CD', mount(r) { root = r; const st = el('style', {}, CSS); r.append(st); root = el('div'); r.append(root); paint(); return () => { root = null; }; } });
  refresh();
  return { stop() { job?.cancel(); remove(); }, status: () => (job ? 'ripping…' : drives.length ? `${drives.length} drive${drives.length === 1 ? '' : 's'}${disc ? ', disc ready' : ''}` : backend ? 'no drive' : 'starting…') };
}

const CSS = `
.cdpage { max-width: 980px; padding: 14px 4px 40px; display: grid; gap: 14px; }
.cdhead { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; } .cdhead h3 { margin: 0 8px 0 0; }
.cdmsg { margin: 0; color: var(--muted); }
.cdtop { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; } .cdmeta { flex: 1; min-width: 280px; display: grid; gap: 10px; }
.cdcover { width: 150px; height: 150px; border-radius: 10px; object-fit: cover; background: var(--panel2); display: grid; place-items: center; font-size: 40px; color: var(--faint); }
.cdgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px 14px; }
.cdf { display: grid; gap: 4px; } .cdf > span { font-size: 12px; color: var(--muted); } .cdf input:not([type=checkbox]), .cdf select { width: 100%; box-sizing: border-box; }
.cdrow { display: flex; gap: 6px; align-items: center; } .cdrow input { flex: 1; }
.cdtracks { width: 100%; border-collapse: collapse; } .cdtracks td { padding: 4px 6px; border-bottom: 1px solid var(--line); } .cdtracks td input:not([type=checkbox]) { width: 100%; box-sizing: border-box; }
.cdopts summary { cursor: pointer; margin-bottom: 10px; }
.cdgo { display: flex; gap: 10px; align-items: center; }
.cdbar { height: 6px; border-radius: 3px; background: var(--panel2); overflow: hidden; } .cdbar > i { display: block; height: 100%; width: 0; background: var(--accent); transition: width .2s; }
.cdrun { display: grid; gap: 8px; justify-items: start; } .cdrun .cdbar { width: 100%; }
.cdlog { max-height: 180px; overflow: auto; font-size: 11px; background: #0f1320; border-radius: 8px; padding: 8px; margin: 0; width: 100%; box-sizing: border-box; white-space: pre-wrap; }
.cdresult h4 { margin: 0 0 8px; } .cdst { width: 22px; text-align: center; font-weight: 700; } .cdst.ok { color: #5fd28a; } .cdst.warn { color: #ffc65c; } .cdst.bad { color: #ff6b6b; }
`;
