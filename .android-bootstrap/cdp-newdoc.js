// 用 CDP Page.addScriptToEvaluateOnNewDocument 向所有新文档（含跨域 iframe）注入脚本，
// 然后重载页面内 iframe 以验证因果：node cdp-newdoc.js <port> <scriptFile> [reloadIframe]
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const port = parseInt(process.argv[2] || '9333', 10);
const src = fs.readFileSync(process.argv[3], 'utf8');
const doReload = process.argv[4] !== 'no';

function getJson(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: p, timeout: 10000 }, r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
function wsConnect(url) {
  const u = new URL(url);
  return new Promise((res, rej) => {
    const s = net.connect({ host: u.hostname, port: u.port }, () => {
      s.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let b = Buffer.alloc(0), up = false;
    s.on('data', d => {
      if (up) return;
      b = Buffer.concat([b, d]);
      const i = b.indexOf('\r\n\r\n');
      if (i < 0) return;
      up = true; res(new Ws(s, b.slice(i + 4)));
    });
    s.on('error', rej);
  });
}
class Ws {
  constructor(s, rest) { this.s = s; this.b = rest || Buffer.alloc(0); this.f = []; this.onmessage = null; s.on('data', d => this._feed(d)); }
  _feed(d) {
    this.b = Buffer.concat([this.b, d]);
    for (;;) {
      if (this.b.length < 2) return;
      const b0 = this.b[0], b1 = this.b[1], op = b0 & 0x0f, fin = b0 & 0x80;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.b.length < 4) return; len = this.b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.b.length < 10) return; len = Number(this.b.readBigUInt64BE(2)); off = 10; }
      if (b1 & 0x80) { if (this.b.length < off + 4) return; off += 4; }
      if (this.b.length < off + len) return;
      const p = this.b.slice(off, off + len);
      this.b = this.b.slice(off + len);
      if (op === 9) { this._s(p, 0xa); continue; }
      this.f.push(p);
      if (fin) { const m = Buffer.concat(this.f); this.f = []; if (this.onmessage) this.onmessage(m.toString()); }
    }
  }
  _s(data, op = 1) {
    const p = Buffer.from(data), mask = crypto.randomBytes(4);
    let h;
    if (p.length < 126) { h = Buffer.alloc(2); h[1] = 0x80 | p.length; }
    else if (p.length < 65536) { h = Buffer.alloc(4); h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); }
    else { h = Buffer.alloc(10); h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
    h[0] = 0x80 | op;
    const o = Buffer.alloc(p.length);
    for (let i = 0; i < p.length; i++) o[i] = p[i] ^ mask[i % 4];
    this.s.write(Buffer.concat([h, mask, o]));
  }
  send(o) { this._s(JSON.stringify(o)); }
}
(async () => {
  const ts = await getJson('/json');
  const page = ts.find(t => t.type === 'page') || ts[0];
  const ws = await wsConnect(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.onmessage = m => { const o = JSON.parse(m); if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); } };
  const call = (method, params) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send({ id: i, method, params }); });
  await call('Page.enable', {});
  const r = await call('Page.addScriptToEvaluateOnNewDocument', { source: src });
  console.log('added ' + JSON.stringify(r.result));
  if (doReload) {
    const r2 = await call('Runtime.evaluate', {
      expression: "(function(){var f=document.querySelector('iframe');if(!f)return 'no-iframe';var s=f.src;f.src='about:blank';setTimeout(function(){f.src=s;},500);return s;})()",
      returnByValue: true
    });
    console.log('reload iframe -> ' + JSON.stringify(r2.result && r2.result.result));
  }
  process.exit(0);
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
