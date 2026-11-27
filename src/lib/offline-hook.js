// Where a source's audio comes from when the offline store keeps a copy of it (src/lib/offline.js sets the resolver).
// Sources ask this first in url() / fetch(), so the player, the stem loader, waveforms and device sync all use the kept
// copy without knowing about the store. A source key is its `path` (a file path, or `<plugin>:<connection>/<id>`).
let resolver = null;
export const setOfflineResolver = fn => { resolver = fn; };
export const offlineUrl = key => (resolver ? resolver(key) : null) || null;
