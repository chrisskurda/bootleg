// Jellyfin source plugin: registers the Jellyfin library source (jellyfin-logic.js). Connect a server in Settings →
// library → Connect a server or service…; its music and music videos then join that library like any other.
import { jellyfin } from './jellyfin-logic.js';

export function activate(api) {
  const source = jellyfin((url, init) => api.net.fetch(url, init), { version: api.platform?.appVersion || '0' });
  const unregister = api.sources.register(source);
  return { stop: unregister, status: () => 'add a server: Settings → library → Connect a server or service…', _test: { source } };
}
