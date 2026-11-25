// A mock DLNA MediaRenderer for tests: description XML, AVTransport/RenderingControl SOAP, SSDP responder.
// It behaves like a device: on Play it fetches the media URL (with a Range request, like real renderers do).
//   node tests/mock-dlna.mjs <logfile>   → prints "dlna: <description url>" when ready; appends JSON lines to <logfile>.
import http from 'node:http'; import fs from 'node:fs'; import dgram from 'node:dgram';
const logFile = process.argv[2], log = o => { if (logFile) fs.appendFileSync(logFile, JSON.stringify(o) + '\n'); };
let state = 'STOPPED', uri = '', pos = 0, vol = 20;
const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (x, n) => { const m = new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`).exec(x); return m ? unesc(m[1]) : ''; };
const srv = http.createServer((req, res) => {
  const port = srv.address().port;
  if (req.url === '/desc.xml') { res.setHeader('content-type', 'text/xml'); return res.end(`<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>Mock Speaker</friendlyName><modelName>MockRenderer 1</modelName><UDN>uuid:mock-1234</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/av</controlURL></service><service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/rc</controlURL></service></serviceList></device></root>`); }
  let body = ''; req.on('data', c => body += c); req.on('end', async () => {
    const action = /#(\w+)"?/.exec(req.headers.soapaction || '')?.[1]; if (!action) { res.writeHead(404); return res.end(); }
    const ok = inner => { res.setHeader('content-type', 'text/xml'); res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="x">${inner}</u:${action}Response></s:Body></s:Envelope>`); };
    if (action === 'SetAVTransportURI') { uri = tag(body, 'CurrentURI'); const meta = tag(body, 'CurrentURIMetaData'); log({ action, uri, title: tag(meta, 'dc:title'), artist: tag(meta, 'upnp:artist'), mime: /http-get:\*:([^:]+):/.exec(meta)?.[1] }); return ok(''); }
    if (action === 'Play') { state = 'PLAYING'; log({ action }); ok(''); if (uri) { try { const r = await fetch(uri, { headers: { Range: 'bytes=0-99' } }); const b = await r.arrayBuffer(); log({ fetched: r.status, bytes: b.byteLength, type: r.headers.get('content-type') }); } catch (e) { log({ fetchError: String(e) }); } } return; }
    if (action === 'Pause') { state = 'PAUSED'; log({ action }); return ok(''); }
    if (action === 'Stop') { state = 'STOPPED'; log({ action }); return ok(''); }
    if (action === 'Seek') { const t = tag(body, 'Target').split(':').map(Number); pos = t[0] * 3600 + t[1] * 60 + t[2]; log({ action, target: tag(body, 'Target') }); return ok(''); }
    if (action === 'SetVolume') { vol = +tag(body, 'DesiredVolume'); log({ action, volume: vol }); return ok(''); }
    if (action === 'GetTransportInfo') return ok(`<CurrentTransportState>${state}</CurrentTransportState>`);
    if (action === 'GetPositionInfo') return ok(`<RelTime>00:00:${String(Math.floor(pos)).padStart(2, '0')}</RelTime><TrackDuration>00:00:06</TrackDuration>`);
    res.writeHead(500); res.end();
  });
});
srv.listen(+process.env.PORT || 0, '127.0.0.1', () => {
  const loc = `http://127.0.0.1:${srv.address().port}/desc.xml`;
  const ssdp = dgram.createSocket({ type: 'udp4', reuseAddr: true }); ssdp.on('error', () => {});
  ssdp.on('message', (m, r) => { if (/M-SEARCH/.test(m.toString()) && /MediaRenderer/.test(m.toString())) ssdp.send(`HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=60\r\nLOCATION: ${loc}\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\nUSN: uuid:mock-1234\r\n\r\n`, r.port, r.address); });
  try { ssdp.bind(1900, () => { try { ssdp.addMembership('239.255.255.250'); } catch { /* no multicast here */ } }); } catch { /* port busy */ }
  console.log('dlna: ' + loc);
});
