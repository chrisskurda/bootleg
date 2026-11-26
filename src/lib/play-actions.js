// What clicking, double-clicking and ▶ do to playback (Settings → Playing). Two models:
//   replace (default): playing an album, playlist or list makes it the queue (the classic player).
//   queue: the queue is yours. Double-click adds to the end (and starts if nothing is playing); ▶ plays at once, inserted
//          after the current track, so the rest of the queue survives. Nothing replaces the queue except “clear”.
// `one`: the gesture was on a single track inside a list (a row in the track list, a track of an album). Replace mode
// still queues the whole list from there (so next/previous walk the list); queue mode takes just that track.
export const PLAY_MODELS = {
  replace: 'Play replaces the queue with the track list, album or playlist (default)',
  queue: 'Build a queue: double-click adds to the end, ▶ plays now and keeps the rest of the queue',
};
export const ALBUM_CLICKS = {
  open: 'Shows its tracks; double-click plays it (default)',
  play: 'Plays it (and shows its tracks)',
};
export const PLAY_DEFAULTS = { playModel: 'replace', albumClick: 'open' };

export function playActions(player, { model, toast = () => {}, plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}` }) {
  const pick = (list, i, one) => (one ? [list[i]] : list.slice(i)).filter(Boolean);
  return {
    // ▶ buttons, playlists, files opened from the OS: start playing this now.
    now(list, i = 0, one = false) { if (!list.length) return; if (model() === 'queue') return player.playNow(pick(list, i, one)); return player.playList(list, i); },
    // double-click (or a click, where that is set to play): in queue mode this only adds, unless nothing is playing.
    activate(list, i = 0, one = false) {
      if (!list.length) return; if (model() !== 'queue') return player.playList(list, i);
      const items = pick(list, i, one); if (!player.enqueue(items)) toast(items.length === 1 ? `Queued “${items[0].title}”` : `Queued ${plural(items.length, 'track')}`);
    },
  };
}
