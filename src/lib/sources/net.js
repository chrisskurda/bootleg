// Network access for source plugins. In the desktop app the Tauri HTTP plugin is used when present (no CORS limits: most
// self-hosted servers don't send CORS headers); in a browser it is plain fetch, so the server must allow CORS.
export const netFetch = (url, init) => (window.__TAURI__?.http?.fetch ? window.__TAURI__.http.fetch(url, init) : fetch(url, init));
