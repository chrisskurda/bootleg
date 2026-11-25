// DLNA / UPnP MediaRenderer output (desktop app: discovery and SOAP control run in Rust; see src-tauri/src/dlna.rs).
// The device fetches the audio itself, from the app's LAN media server (local files) or straight from the server (Subsonic).
const T = () => window.__TAURI__?.core;
const secs = x => Math.max(0, +x || 0);
export const dlna = {
  id: 'dlna', name: 'DLNA / UPnP',
  async discover({ timeoutMs = 3000 } = {}) { if (!T()) return []; return (await T().invoke('dlna_discover', { timeoutMs })).map(d => ({ ...d, plugin: 'dlna' })); },
  async add(location) { const d = await T().invoke('dlna_add', { location: /^https?:\/\//.test(location) ? location : 'http://' + location }); return { ...d, plugin: 'dlna' }; },
  play: (d, m) => T().invoke('dlna_play', { av: d.av, url: m.url, title: m.title || '', artist: m.artist || '', album: m.album || '', mime: m.mime || 'audio/mpeg' }),
  pause: d => T().invoke('dlna_transport', { av: d.av, action: 'Pause' }),
  resume: d => T().invoke('dlna_transport', { av: d.av, action: 'Play' }),
  stop: d => T().invoke('dlna_transport', { av: d.av, action: 'Stop' }),
  seek: (d, s) => T().invoke('dlna_seek', { av: d.av, secs: secs(s) }),
  volume: (d, v) => (d.rc ? T().invoke('dlna_volume', { rc: d.rc, volume: Math.round(Math.max(0, Math.min(1, v)) * 100) }) : Promise.resolve()),
  async status(d) { const s = await T().invoke('dlna_status', { av: d.av }); return { state: /PLAYING/i.test(s.state) ? 'playing' : /PAUSED/i.test(s.state) ? 'paused' : 'stopped', pos: s.pos, dur: s.dur }; },
};
