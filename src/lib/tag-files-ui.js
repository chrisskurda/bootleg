// The review list for writing tag edits to files: every edited track with its changes (old → new) and the file it would go
// to. Tick the ones to write now, or approve them for the scheduled writer. Nothing is written without being looked at here.
const LABEL = { title: 'title', artist: 'artist', album: 'album', albumArtist: 'album artist', year: 'year', track: 'track', disc: 'disc', genre: 'genre' };

export async function openTagReview(tf, { h, toast, onDone = () => {} }) {
  const entries = await tf.pending(), dlg = h('dialog', { class: 'tagdlg wide', 'aria-label': 'Write tag edits to files' }), status = h('div', { class: 'muted small', role: 'status' });
  const close = () => { dlg.close(); dlg.remove(); };
  const rows = entries.map(e => {
    const box = h('input', { type: 'checkbox', checked: e.approved && !e.written, 'aria-label': 'Select ' + e.t.title }), where = h('div', { class: 'muted small' }, e.written ? 'written — waiting for the server to re-read it' : 'finding the file…');
    return { e, box, where, el: h('label', { class: 'trow' }, box, h('div', {}, h('div', {}, h('b', {}, e.t.title), ' ', h('span', { class: 'muted' }, e.t.artist || ''), e.approved ? h('span', { class: 'chip' }, 'approved') : ''),
      h('div', { class: 'small' }, e.changes.map(c => `${LABEL[c.field] || c.field}: ${c.from || '—'} → ${c.to || '—'}`).join(' · ')), where)) };
  });
  const sel = () => rows.filter(r => r.box.checked);
  const write = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
    const pick = sel(); if (!pick.length) return toast('Tick the edits to write', true); write.disabled = true;
    try {
      const res = await tf.apply(pick.map(r => r.e), { onProgress: (i, n, e) => { status.textContent = `Writing ${i} of ${n}: ${e.t.title}…`; } });
      for (const r of res) { const row = rows.find(x => x.e === r.entry); row.where.textContent = r.ok ? (r.skipped || `written: ${r.path}`) : `not written: ${r.error}`; row.where.className = r.ok ? 'small ok' : 'small err'; row.box.checked = false; }
      const ok = res.filter(r => r.ok).length; status.textContent = `${ok} written, ${res.length - ok} not written.`; onDone();
    } catch (err) { toast(String(err.message || err), true); } finally { write.disabled = false; }
  } }, 'Write selected now');
  const approve = h('button', { class: 'btn', type: 'button', title: 'The scheduled writer only writes approved edits', onclick: async () => {
    for (const r of rows) await tf.store.setEditState(r.e.key, { approved: r.box.checked }); toast(`${sel().length} approved for the schedule`); close(); onDone();
  } }, 'Approve ticked for the schedule');
  dlg.append(h('form', { method: 'dialog' },
    h('h3', {}, 'Write tag edits to files'),
    h('div', { class: 'muted small' }, entries.length ? 'Each file gets a new copy with the new tags, which then replaces it in one step. A server is asked to rescan afterwards; its bootleg edit is dropped once it reports the new tags.' : 'No tag edits are waiting. Edit a track’s tags (the “edit” button on a track) to start.'),
    entries.length ? h('label', { class: 'muted small' }, h('input', { type: 'checkbox', onchange: e => rows.forEach(r => { if (!r.e.written) r.box.checked = e.target.checked; }) }), ' select all') : '',
    h('div', { class: 'tlist' }, ...rows.map(r => r.el)), status,
    h('div', { class: 'cbtns' }, entries.length ? write : '', entries.length ? approve : '', h('button', { class: 'btn', type: 'button', onclick: close }, 'Close'))));
  dlg.addEventListener('cancel', () => dlg.remove()); document.body.append(dlg); dlg.showModal();
  (async () => { for (const r of rows) {      // one at a time keeps a slow share responsive
    if (r.e.written || !dlg.isConnected) continue; const x = await tf.resolve(r.e.t).catch(err => ({ error: String(err.message || err) }));
    r.where.textContent = x.path ? `→ ${x.path} (${x.how})` : `can’t write yet: ${x.error}`; if (x.error) r.where.className = 'small err';
  } })();
  return dlg;
}
