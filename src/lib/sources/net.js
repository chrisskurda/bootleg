// Network access for source plugins. In the desktop app the Tauri HTTP plugin is used when present (no CORS limits: most
// self-hosted servers don't send CORS headers); in a browser it is plain fetch, so the server must allow CORS.
export const netFetch = (url, init) => (window.__TAURI__?.http?.fetch ? window.__TAURI__.http.fetch(url, init) : fetch(url, init));
// Media from a server that doesn't allow other origins (a source plugin with `cors: false`, e.g. Plex): the desktop app
// streams it through its loopback media proxy (src-tauri/src/proxy.rs), which adds CORS, so the player's audio graph
// hears it. In a browser there is no way around it: the URL is used as it is.
export const mediaUrl = async url => (window.__TAURI__?.core ? window.__TAURI__.core.invoke('media_proxy', { url }) : url);
