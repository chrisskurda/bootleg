// Jellyfin source (docs/plugins/SERVERS.md): the library source contract (src/lib/sources/plugin.js) over Jellyfin's API.
// Music (Audio items) and music videos (MusicVideo items) in one scan; favourites both ways; playlists; offline copies.
// `net` is a fetch (api.net.fetch: no CORS limits on the desktop; Jellyfin allows any origin anyway). No DOM here.
//
// Auth: /Users/AuthenticateByName with the user's password once; the access token is kept (in the keychain, `secrets`),
// never the password. Requests carry the token in the Authorization header; media URLs (what <audio>/<video> load)
// carry it as api_key, as Jellyfin's own web player does.

const CLIENT = 'bootleg', PAGE = 500;
export const base = u => String(u || '').trim().replace(/\/+$/, '').replace(/\/web(\/index\.html)?(#.*)?$/, '');
const authHeader = (c, version) => `MediaBrowser Client="${CLIENT}", Device="${c.device || CLIENT}", DeviceId="${c.deviceId}", Version="${version}"${c.token ? `, Token="${c.token}"` : ''}`;
// Containers and codecs a <video> element plays as they are; anything else the server remuxes or converts to MP4.
const WEB_CONTAINERS = new Set(['mp4', 'm4v', 'mov', 'webm']), WEB_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']), WEB_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
const ticks = t => t ? t / 1e7 : undefined;
const hash = s => { let h = 0; for (const c of String(s || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

export function jellyfin(net, { version = '0.1.0' } = {}) {
  async function call(ses, path, { method = 'GET', body, query } = {}) {
    const q = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString() : '';
    let r; try { r = await net(`${ses.base}${path}${q}`, { method, headers: { Authorization: authHeader(ses.config, version), Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); }
    catch (e) { throw new Error(`Could not reach the server (${e.message || e})`); }
    if (r.status === 401) throw new Error('The server did not accept the sign-in (sign in again in Settings)');
    if (!r.ok) throw new Error(`Server answered ${r.status}`);
    return r.status === 204 ? null : r.headers?.get?.('content-type')?.includes('json') === false ? null : r.json().catch(() => null);
  }
  const media = (ses, path, query = {}) => `${ses.base}${path}?${new URLSearchParams({ ...query, api_key: ses.config.token }).toString()}`;
  const session = config => ({ config, base: base(config.url) });

  function item(it) {
    const ms = it.MediaSources?.[0] || {}, streams = ms.MediaStreams || it.MediaStreams || [], formats = String(it.Container || ms.Container || '').toLowerCase().split(','),
      container = /\.([a-z0-9]{2,4})$/i.exec(it.Path || ms.Path || '')?.[1].toLowerCase() || (formats.includes('mp4') ? 'mp4' : formats[0]);      // ffprobe names an MP4 "mov,mp4,m4a,…"
    const common = { id: it.Id, title: it.Name || 'Untitled', year: it.ProductionYear || '', duration: ticks(it.RunTimeTicks), size: ms.Size || 0, changed: hash(it.Etag || it.DateCreated), bitrate: ms.Bitrate ? Math.round(ms.Bitrate / 1000) : 0, starred: !!it.UserData?.IsFavorite, path: it.Path || ms.Path || undefined };
    if (it.Type === 'MusicVideo') {
      const v = streams.find(s => s.Type === 'Video')?.Codec?.toLowerCase(), a = streams.find(s => s.Type === 'Audio')?.Codec?.toLowerCase();
      const direct = WEB_CONTAINERS.has(container) && (!v || WEB_VIDEO.has(v)) && (!a || WEB_AUDIO.has(a));
      return { ...common, kind: 'video', artist: (it.Artists || []).join(', ') || it.AlbumArtist || '', album: it.Album || '', suffix: direct ? container : 'mp4', direct, coverId: it.ImageTags?.Primary ? it.Id : '' };
    }
    return { ...common, artist: (it.Artists || []).join(', ') || it.AlbumArtist || '', album: it.Album || '', albumArtist: it.AlbumArtist || '', track: it.IndexNumber || 0, disc: it.ParentIndexNumber || 0, genre: it.Genres?.[0] || '', suffix: container || 'mp3',
      coverId: it.AlbumPrimaryImageTag && it.AlbumId ? it.AlbumId : it.ImageTags?.Primary ? it.Id : '' };
  }

  return {
    id: 'jellyfin', name: 'Jellyfin', description: 'Music and music videos from a Jellyfin server.',
    fields: [
      { key: 'url', label: 'Server address', type: 'url', required: true, placeholder: 'http://192.168.1.10:8096', hint: 'The address you open Jellyfin at in a browser.' },
      { key: 'username', label: 'Username', type: 'text', required: true },
      { key: 'password', label: 'Password', type: 'password', hint: 'Used once to sign in; only the access token Jellyfin gives back is kept, in the system keychain.' },
    ],
    secrets: ['token'],
    async connect(v) {
      const deviceId = 'bootleg-' + [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
      const pre = { config: { url: base(v.url), deviceId }, base: base(v.url) };
      const r = await call(pre, '/Users/AuthenticateByName', { method: 'POST', body: { Username: String(v.username || '').trim(), Pw: v.password || '' } });
      if (!r?.AccessToken) throw new Error('That does not look like a Jellyfin server');
      const config = { url: pre.base, deviceId, userId: r.User?.Id, serverId: r.ServerId, username: r.User?.Name || v.username, token: r.AccessToken };
      return { config, title: `${config.username}@${new URL(config.url).host}` };
    },
    session,
    async *scan(ses, { signal } = {}) {
      let start = 0, songs = 0, videos = 0;
      for (;;) {
        if (signal?.aborted) return;
        const j = await call(ses, `/Users/${ses.config.userId}/Items`, { query: { Recursive: 'true', IncludeItemTypes: 'Audio,MusicVideo', Fields: 'MediaSources,Genres,Path,Etag,DateCreated,ProductionYear', SortBy: 'SortName', SortOrder: 'Ascending', EnableImageTypes: 'Primary', StartIndex: start, Limit: PAGE } });
        const items = (j?.Items || []).map(item); songs += items.filter(x => x.kind !== 'video').length; videos += items.filter(x => x.kind === 'video').length; start += (j?.Items || []).length;
        yield { items, progress: `Reading Jellyfin… ${songs.toLocaleString()} tracks${videos ? `, ${videos.toLocaleString()} videos` : ''}` };
        if (!j?.Items?.length || start >= (j.TotalRecordCount ?? start)) break;
      }
    },
    async playlists(ses) {
      const list = (await call(ses, `/Users/${ses.config.userId}/Items`, { query: { Recursive: 'true', IncludeItemTypes: 'Playlist' } }))?.Items || [];
      return Promise.all(list.map(async p => ({ id: p.Id, name: p.Name || 'Playlist', owner: '', items: ((await call(ses, `/Playlists/${p.Id}/Items`, { query: { UserId: ses.config.userId } }))?.Items || []).map(x => x.Id) })));
    },
    setStarred: (ses, id, on) => call(ses, `/Users/${ses.config.userId}/FavoriteItems/${id}`, { method: on ? 'POST' : 'DELETE' }),
    rescan: ses => call(ses, '/Library/Refresh', { method: 'POST' }),
    streamUrl: (ses, it) => it.kind === 'video'
      ? it.direct === false ? media(ses, `/Videos/${it.id}/stream.mp4`, { static: 'false', Container: 'mp4', VideoCodec: 'h264', AudioCodec: 'aac', MediaSourceId: it.id, DeviceId: ses.config.deviceId }) : media(ses, `/Videos/${it.id}/stream`, { static: 'true', MediaSourceId: it.id })
      : media(ses, `/Audio/${it.id}/stream`, { static: 'true' }),
    coverUrl: (ses, it, px = 512) => it.coverId ? `${ses.base}/Items/${it.coverId}/Images/Primary?maxWidth=${px}&quality=90` : '',
    fetch: (ses, u, init) => net(u, init),
    offline: true,
    download: (ses, it, quality) => {
      const kbps = { high: 320, saver: 128 }[quality];
      if (!kbps || (String(it.suffix).toLowerCase() === 'mp3' && it.bitrate && it.bitrate <= kbps)) return { url: media(ses, `/Items/${it.id}/Download`), ext: it.suffix || 'mp3', quality: 'original', bytes: it.size || undefined };
      return { url: media(ses, `/Audio/${it.id}/stream.mp3`, { static: 'false', AudioCodec: 'mp3', AudioBitRate: kbps * 1000 }), ext: 'mp3', quality, bytes: (it.duration || 0) * kbps * 125 };
    },
  };
}
