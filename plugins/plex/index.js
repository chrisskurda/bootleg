// Plex source plugin: registers the Plex library source (plex-logic.js). Connect a server in Settings → library →
// Connect a server or service… (plex.tv opens in your browser to approve bootleg).
import { plex } from './plex-logic.js';

export function activate(api) {
  const source = plex((url, init) => api.net.fetch(url, init), { open: url => api.ui.openExternal(url), version: api.platform?.appVersion || '0' });
  Object.defineProperty(source, 'videos', { get: () => api.settings.get('videos', true) });      // the "Music videos" setting, read at each scan
  const unregister = api.sources.register(source);
  return { stop: unregister, status: () => api.platform?.os === 'web' ? 'lists a Plex library; playing it needs the desktop app (Plex allows no other web origins)' : 'add a server: Settings → library → Connect a server or service…', _test: { source } };
}
