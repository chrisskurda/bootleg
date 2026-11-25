// ─── Output plugins (cast targets) ───────────────────────────────────────────────────────────────────────────────────
// An output plugin lets bootleg play on another device: a DLNA/UPnP renderer today; Google Cast, AirPlay speakers, Sonos,
// a Bluetooth bridge … tomorrow. (Source plugins bring music IN; output plugins send it OUT.)  ./dlna.js is the reference.
//
//   plugin = {
//     id: 'dlna', name: 'DLNA / UPnP',
//     async discover({ timeoutMs }) → Device[]            // find devices on the network
//     async add?(input)             → Device              // optional: add one by address (networks that block discovery)
//     async play(device, { url, title, artist, album, mime, duration, art })   // art: cover image URL the device can fetch (optional)   // start this URL (already reachable from the device)
//     async pause(device)  async resume(device)  async stop(device)
//     async seek(device, seconds)  async volume(device, 0..1)
//     async status?(device) → { state: 'playing'|'paused'|'stopped', pos, dur }
//   }
//   Device = { id, name, plugin: 'dlna', …plugin-specific fields }
//
// The Outputs manager (./manager.js) keeps local playback running *silently* while casting, so the visualizer, timeline,
// notes and queue keep working; transport commands are mirrored to the device.
const registry = new Map();
export const registerOutput = p => { for (const k of ['id', 'name', 'discover', 'play', 'pause', 'resume', 'stop', 'seek', 'volume']) if (!(k in p)) throw new Error(`output plugin is missing "${k}"`); registry.set(p.id, p); return p; };
export const getOutput = id => registry.get(id) || null;
export const listOutputs = () => [...registry.values()];
