// bootleg extension: Car Thing bridge. The protocol lives in bridge.js; this file only wires it to the extension API.
// The address setting may list several bridges (comma or space separated): the bridgething desktop app for a Car Thing,
// and a bootleg-pod handheld on Wi-Fi (its Remote page shows its address). Each gets its own connection.
import { Bridge, BRIDGE_URL } from './bridge.js';
export const addresses = s => String(s || '').split(/[\s,]+/).map(x => x.trim()).filter(x => /^wss?:\/\//.test(x));
export function activate(api) {
  const list = addresses(api.settings.get('url', BRIDGE_URL)), urls = list.length ? list : [BRIDGE_URL];
  const bridges = urls.map(url => new Bridge({ player: api.player, viz: api.viz, url }));
  bridges.forEach(b => b.start());
  const host = u => u.replace(/^wss?:\/\//, '').replace(/[/?].*$/, '');
  return {
    stop: () => bridges.forEach(b => b.dispose()),
    status: () => bridges.length === 1 ? (bridges[0].open ? 'connected' : 'waiting…') + ` (${host(urls[0])})` : bridges.map((b, i) => `${host(urls[i])}: ${b.open ? 'connected' : 'waiting'}`).join(' · '),
  };
}
