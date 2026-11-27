// Music videos on screen (docs/VIDEOS.md): the Videos page, the video stage and its bar on Now playing, the 🎬 chip on
// track rows, and the dialog that links videos to a track. Matching and the link store are in videos.js; playback is
// the player's (player.videoEl, videoMode, watch()).
import { videoIndex, videosFor, pickList, VideoLinks } from './videos.js';

export function initVideos({ h, $, lib, player, keyOf, links = new VideoLinks(null), fmt, toast = () => {}, playList, sourceName = () => '' }) {
  // the index of automatic matches follows the library (videos come and go, and their tags change)
  let ix = null, ixFor = null;
  const index = () => { const k = `${lib.ver}|${lib.videos.length}`; if (ixFor !== k) { ix = videoIndex(lib.videos); ixFor = k; } return ix; };      // cheap: one pass over the videos
  const byPath = { get: p => { const e = lib._byPath.get(p); return e?.kind === 'video' ? e : null; } };
  const of = t => videosFor(t, keyOf(t), { links, index: index(), byPath });
  player.hooks.videoFor = t => of(t)[0]?.video || null;
  const label = v => [v.artist, v.title].filter(Boolean).join(' – ') || v.src?.name || 'Video';
  const where = v => v.src?.remote ? sourceName(v.src.remote) || v.src.remote.plugin : v.src?.path?.split('/').slice(-2, -1)[0] || 'file';

  // ---- the video element lives in the page all the time (a media element taken out of the document stops playing)
  const home = h('div', { id: 'videoHome', hidden: true }); document.body.append(home); home.append(player.videoEl);
  player.videoEl.addEventListener('dblclick', () => fullscreen());
  const fullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : player.videoEl.requestFullscreen?.())?.catch?.(() => {});

  // ---- Now playing: the stage (when a video plays) and the bar (when the track has videos, or is one)
  function paintNow() {
    const stage = $('#nowVideo'), bar = $('#nowVideoBar'); if (!stage || !bar) return;
    const it = player.item, vids = it && it.kind !== 'video' ? of(it) : [], playing = player.video;
    if (playing) { if (player.videoEl.parentNode !== stage) stage.append(player.videoEl); } else if (player.videoEl.parentNode !== home) home.append(player.videoEl);
    stage.hidden = !playing; $('#nowCover') && ($('#nowCover').hidden = !!playing);
    if (!it || (!vids.length && it.kind !== 'video' && !lib.videos.length)) { bar.hidden = true; bar.replaceChildren(); return; }
    bar.hidden = false;
    bar.replaceChildren(
      it.kind === 'video' ? h('span', { class: 'muted small' }, `Music video · ${where(it)}`) :
        h('label', { class: 'vmode', title: 'Tracks with a music video play the video (with its own sound) instead' }, h('input', { type: 'checkbox', checked: player.videoMode, onchange: e => player.setVideoMode(e.target.checked) }), ' Play music videos'),
      ...vids.map(({ video: v, how }) => h('button', { class: 'btn small' + (playing === v ? ' on' : ''), title: `${label(v)} (${where(v)}${how === 'auto' ? ', matched by title' : ', linked by you'})`, onclick: () => player.watch(playing === v ? null : v) }, playing === v ? '■ Back to the track' : `▶ ${vids.length > 1 ? label(v) : 'Watch the video'}`)),
      playing ? h('button', { class: 'btn small', title: 'Full screen (or double-click the video)', onclick: fullscreen }, '⛶') : '',
      it.kind !== 'video' && lib.videos.length ? h('button', { class: 'link small', onclick: () => linkDialog(it) }, vids.length ? 'change…' : 'link a video…') : '');
  }
  player.addEventListener('change', () => { const k = `${player.item?.id}|${player.video?.id}|${player.videoMode}`; if (k !== paintNow.k) { paintNow.k = k; paintNow(); } });
  links.addEventListener('change', () => { paintNow.k = null; paintNow(); });

  // ---- a track's chip (only when it has a video)
  const chip = t => { if (!lib.videos.length || t.kind === 'video') return ''; const n = of(t).length; return n ? h('button', { class: 'chip vchip', title: `${n === 1 ? 'A music video' : `${n} music videos`}: click to link or change`, onclick: e => { e.stopPropagation(); linkDialog(t); } }, '🎬') : ''; };

  // ---- link dialog: this track's videos (watch, unlink) and every video to link
  function linkDialog(t) {
    const dlg = h('dialog', { class: 'vdlg', 'aria-label': 'Music videos' }), key = keyOf(t), q = h('input', { type: 'search', placeholder: 'Search videos…', oninput: () => paint() });
    const close = () => { dlg.close(); dlg.remove(); };
    const paint = () => {
      const cur = of(t), have = new Set(cur.map(x => x.video)), hidden = links.hidden.get(key);
      list.replaceChildren(
        h('h4', {}, 'Linked to this track'),
        cur.length ? h('ul', { class: 'vlist' }, ...cur.map(({ video: v, how }) => h('li', {}, h('span', {}, h('b', {}, label(v)), h('span', { class: 'muted small' }, ` · ${where(v)} · ${how === 'auto' ? 'matched by artist and title' : 'linked by you'}`)),
          h('button', { class: 'btn small', onclick: () => { close(); if (player.item === t) player.watch(v); else playList([t], 0).then(() => player.watch(v)); } }, '▶ Watch'),
          h('button', { class: 'link small', onclick: async () => { await links.unlink(key, v.src.path, how === 'auto'); paint(); } }, how === 'auto' ? 'not this one' : 'unlink')))) : h('p', { class: 'muted small' }, 'None yet.'),
        hidden?.size ? h('p', { class: 'small' }, h('button', { class: 'link', onclick: async () => { await links.restore(key); paint(); } }, `Show ${hidden.size === 1 ? 'the match' : `${hidden.size} matches`} you turned down again`)) : '',
        h('h4', {}, 'Link another video'),
        h('ul', { class: 'vlist' }, ...pickList(lib.videos, t, q.value).filter(v => !have.has(v)).slice(0, 60).map(v => h('li', {}, h('span', {}, label(v), h('span', { class: 'muted small' }, ` · ${where(v)}${v.duration ? ' · ' + fmt(v.duration) : ''}`)),
          h('button', { class: 'btn small', onclick: async () => { await links.link(key, v.src.path); paint(); } }, 'Link')))));
    };
    const list = h('div', { class: 'vdlist' });
    dlg.append(h('div', { class: 'vdhead' }, h('h3', {}, `Music videos for “${t.title}”`), h('button', { class: 'btn', onclick: close }, 'Done')), q, list);
    dlg.addEventListener('cancel', () => dlg.remove()); document.body.append(dlg); dlg.showModal(); paint(); q.focus();
  }

  // ---- the Videos page
  function render(query = '') {
    const nav = $('.nav[data-view="videos"]'), all = lib.visibleVideos; if (nav) { nav.hidden = !lib.videos.length; $('#nVideos').textContent = all.length || ''; }
    const root = $('#videoList'); if (!root || $('#view-videos').hidden) return;
    const list = lib.search(all, query);
    root.replaceChildren(...list.map((v, i) => h('div', { class: 'rcard vcard' + (player.item === v ? ' playing' : ''), onclick: () => playList(list, i) },
      v.coverUrl ? h('img', { class: 'vthumb', src: v.coverUrl, loading: 'lazy', alt: '' }) : h('div', { class: 'vthumb blank' }, '🎬'),
      h('div', {}, h('div', { class: 'big' }, v.title), h('div', { class: 'muted small' }, [v.artist, v.year, v.duration && fmt(v.duration), where(v)].filter(Boolean).join(' · '))))));
    $('#emptyVideos').hidden = list.length > 0;
  }
  return { paintNow, chip, linkDialog, render, of, links };
}
