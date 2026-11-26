// Posting a note (or a track) to social media. Nothing is sent from here: we open the network's own "compose" page with
// the text filled in (or the system share sheet, or the clipboard), and the user posts it there, signed in as themselves.
export const APP_LINK = 'https://github.com/chrisskurda/bootleg';
export const SHARE_DEFAULTS = { mastodon: 'mastodon.social', shareTags: true, shareLink: false };
const enc = encodeURIComponent, mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export const NETWORKS = [
  { id: 'bluesky', name: 'Bluesky', limit: 300, url: t => `https://bsky.app/intent/compose?text=${enc(t)}` },
  { id: 'mastodon', name: 'Mastodon', limit: 500, url: (t, o) => `https://${String(o.mastodon || SHARE_DEFAULTS.mastodon).replace(/^https?:\/\//, '').replace(/\/.*$/, '')}/share?text=${enc(t)}` },
  { id: 'threads', name: 'Threads', limit: 500, url: t => `https://www.threads.net/intent/post?text=${enc(t)}` },
  { id: 'x', name: 'X', limit: 280, url: t => `https://x.com/intent/post?text=${enc(t)}` },
];

// The post: the note in quotes, then the track (and the moment), then the tags / link. When it is too long for a network
// only the note is shortened — the track line and the tags always fit.
export function postText({ text = '', track = null, at = null, rating = 0 }, opts = SHARE_DEFAULTS, limit = Infinity) {
  const head = track ? `♪ ${track.title}${track.artist ? ' — ' + track.artist : ''}${at != null ? ` (at ${mmss(at)})` : ''}${rating ? ' ' + '★'.repeat(Math.round(rating)) : ''}` : '';
  const tail = [opts.shareTags ? '#nowplaying #bootleg' : '', opts.shareLink ? APP_LINK : ''].filter(Boolean).join(' ');
  let body = text.trim() ? `“${text.trim()}”` : ''; const fixed = [head, tail].filter(Boolean).join('\n\n'), room = limit - fixed.length - (fixed && body ? 2 : 0);
  if (body.length > room) body = room > 3 ? body.slice(0, room - 2).trimEnd() + '…”' : '';
  return [body, head, tail].filter(Boolean).join('\n\n');
}

// The feed as Markdown (newest first), for "share my whole feed".
export function feedMarkdown(items, opts = SHARE_DEFAULTS) {
  const out = ['# My bootleg notes', ''];
  for (const { track, rating, tags, notes } of items) {
    out.push(`## ${track.title}${track.artist ? ' — ' + track.artist : ''}${rating ? ' ' + '★'.repeat(Math.round(rating)) : ''}`);
    if (tags?.length) out.push(tags.map(t => '#' + t.replace(/\s+/g, '')).join(' '));
    for (const n of notes) out.push(`- ${n.at != null ? `**${mmss(n.at)}${n.to != null ? '–' + mmss(n.to) : ''}** ` : ''}${n.text.replace(/\n+/g, ' ')}`);
    out.push('');
  }
  if (opts.shareTags || opts.shareLink) out.push([opts.shareTags ? '#nowplaying #bootleg' : '', opts.shareLink ? APP_LINK : ''].filter(Boolean).join(' '));
  return out.join('\n');
}

export function openExternal(url) {
  const T = window.__TAURI__; if (T) return T.core.invoke('open_external', { url });
  window.open(url, '_blank', 'noopener');
}

// The "Post" dialog: the text (editable), how it fits each network, and a button per network.
export function openShare(post, { h, opts, toast, title = 'Post' }) {
  const ta = h('textarea', { rows: 6, class: 'sharetext', 'aria-label': 'Post text' }), counts = h('div', { class: 'muted small' }); ta.value = postText(post, opts);
  const dlg = h('dialog', { class: 'tagdlg sharedlg', 'aria-label': title }), close = () => { dlg.close(); dlg.remove(); };
  const paint = () => { counts.textContent = NETWORKS.map(n => `${n.name} ${ta.value.length}/${n.limit}`).join(' · '); };
  ta.oninput = paint; paint();
  const go = n => { let text = ta.value; if (text.length > n.limit) text = postText(post, opts, n.limit); openExternal(n.url(text, opts)); close(); };
  const copy = async () => { try { await navigator.clipboard.writeText(ta.value); toast('Copied — paste it anywhere'); close(); } catch { ta.select(); toast('Press Cmd/Ctrl+C to copy', true); } };
  dlg.append(h('form', { method: 'dialog' }, h('h3', {}, title),
    h('div', { class: 'muted small' }, 'Opens the network with this text filled in; you post it there. A post that is too long for a network gets its note shortened.'),
    ta, counts,
    h('div', { class: 'cbtns' }, ...NETWORKS.map(n => h('button', { class: 'btn', type: 'button', onclick: () => go(n) }, n.name)),
      navigator.share ? h('button', { class: 'btn', type: 'button', onclick: () => navigator.share({ text: ta.value }).then(close, () => {}) }, 'Share…') : '',
      h('button', { class: 'btn', type: 'button', onclick: copy }, 'Copy'), h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'))));
  dlg.addEventListener('cancel', () => dlg.remove()); document.body.append(dlg); dlg.showModal(); ta.focus(); return dlg;
}
