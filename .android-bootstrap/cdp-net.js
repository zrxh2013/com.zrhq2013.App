// CDP 网络观测：node cdp-net.js <port> <seconds>
// 启用 Network 域，收集请求/响应/失败，输出慢请求与未完成请求
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const port = parseInt(process.argv[2] || '9333', 10);
const secs = parseInt(process.argv[3] || '60', 10);

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, timeout: 10000 }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function wsConnect(url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: u.hostname, port: u.port }, () => {
      sock.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = Buffer.alloc(0), upgraded = false;
    const onData = chunk => {
      if (upgraded) return;
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = buf.slice(0, idx).toString();
      if (!/101/.test(head.split('\r\n')[0])) return reject(new Error(head.split('\r\n')[0]));
      upgraded = true;
      sock.removeListener('data', onData);
      const o = new Ws(sock, buf.slice(idx + 4));
      resolve(o);
    };
    sock.on('data', onData);
    sock.on('error', reject);
  });
}

class Ws {
  constructor(sock, rest) { this.sock = sock; this.buf = rest || Buffer.alloc(0); this.frags = []; this.onmessage = null; sock.on('data', d => this._feed(d)); }
  _feed(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1], op = b0 & 0x0f, fin = (b0 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const masked = (b1 & 0x80) !== 0;
      let mask = null;
      if (masked) { if (this.buf.length < off + 4) return; mask = this.buf.slice(off, off + 4); off += 4; }
      if (this.buf.length < off + len) return;
      const payload = this.buf.slice(off, off + len);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.buf = this.buf.slice(off + len);
      if (op === 8) return;
      if (op === 9) { this._send(payload, 0xa); continue; }
      this.frags.push(payload);
      if (fin) { const m = Buffer.concat(this.frags); this.frags = []; if (this.onmessage) this.onmessage(m.toString()); }
    }
  }
  _send(data, op = 0x1) {
    const p = Buffer.from(data), mask = crypto.randomBytes(4);
    let head;
    if (p.length < 126) { head = Buffer.alloc(2); head[1] = 0x80 | p.length; }
    else if (p.length < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(p.length, 2); }
    else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(p.length), 2); }
    head[0] = 0x80 | op;
    const out = Buffer.alloc(p.length);
    for (let i = 0; i < p.length; i++) out[i] = p[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([head, mask, out]));
  }
  send(o) { this._send(JSON.stringify(o)); }
}

(async () => {
  const targets = await getJson('/json');
  const page = targets.find(t => t.type === 'page') || targets[0];
  const ws = await wsConnect(page.webSocketDebuggerUrl);
  const reqs = new Map();
  const done = [];
  const failed = [];
  let id = 0;
  ws.onmessage = msg => {
    const m = JSON.parse(msg);
    if (m.method === 'Network.requestWillBeSent') {
      const r = m.params.request;
      reqs.set(m.params.requestId, { url: r.url, method: r.method, t0: Date.now(), type: m.params.type });
    } else if (m.method === 'Network.responseReceived') {
      const e = reqs.get(m.params.requestId);
      if (e) { e.status = m.params.response.status; e.mime = m.params.response.mimeType; }
    } else if (m.method === 'Network.loadingFinished') {
      const e = reqs.get(m.params.requestId);
      if (e) { e.dur = Date.now() - e.t0; e.ok = true; done.push(e); reqs.delete(m.params.requestId); }
    } else if (m.method === 'Network.loadingFailed') {
      const e = reqs.get(m.params.requestId);
      if (e) { e.err = m.params.errorText; e.dur = Date.now() - e.t0; failed.push(e); reqs.delete(m.params.requestId); }
    }
  };
  ws.send({ id: ++id, method: 'Network.enable', params: { maxTotalBufferSize: 10000000 } });
  console.error('[net] capturing ' + secs + 's ...');
  await new Promise(r => setTimeout(r, secs * 1000));
  const live = [...reqs.values()].map(e => ({ url: e.url.slice(0, 110), method: e.method, pending: Date.now() - e.t0 }));
  const out = {
    finished: done.filter(e => e.dur > 1500 || (e.status >= 400)).map(e => ({ status: e.status, dur: e.dur, url: e.url.slice(0, 110) })).slice(-15),
    failed: failed.map(e => ({ err: e.err, dur: e.dur, url: e.url.slice(0, 110) })),
    pending: live
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
