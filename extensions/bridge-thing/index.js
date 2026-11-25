// bootleg extension: Car Thing bridge. The protocol lives in bridge.js; this file only wires it to the extension API.
import { Bridge, BRIDGE_URL } from './bridge.js';
export function activate(api) {
  const b = new Bridge({ player: api.player, viz: api.viz, url: api.settings.get('url', BRIDGE_URL) }); b.start();
  return { stop: () => b.dispose(), status: () => (b.open ? 'connected to the bridgething app' : 'waiting for the bridgething app…') };
}
