// 零依赖 CDP 客户端：node cdp-eval.js <port> <exprFile|-> [timeoutMs]
// 连接 http://127.0.0.1:<port>/json 找到首个 page target，Runtime.evaluate 求值（awaitPromise）
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const port = parseInt(process.argv[2] || '9333', 10);
const exprFile = process.argv[3] || '-';
const timeout = parseInt(process.argv[4] || '30000', 10);
const expr = require('fs').readFileSync(exprFile === '-' ? 0 : exprFile, 'utf8');

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 10000 }, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json: ' + b.slice(0, 200))); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('http timeout')); });
  });
}

function wsConnect(url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect({ host: u.hostname, port: u.port }, () => {
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
        `Host: ${u.host}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const onData = chunk => {
      if (upgraded) return;
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = buf.slice(0, idx).toString();
      if (!/101/.test(head.split('\r\n')[0])) return reject(new Error('handshake failed: ' + head.split('\r\n')[0]));
      upgraded = true;
      sock.removeListener('data', onData);
      sock.removeListener('error', reject);
      resolve(new Ws(sock, buf.slice(idx + 4)));
    };
    sock.on('data', onData);
    sock.on('error', reject);
    sock.setTimeout(timeout, () => reject(new Error('ws timeout')));
  });
}

class Ws {
  constructor(sock, rest) {
    this.sock = sock;
    this.buf = rest || Buffer.alloc(0);
    this.frags = [];
    this.closed = false;
    this.onmessage = null;
    sock.on('data', d => this._feed(d));
    sock.on('close', () => { this.closed = true; });
  }
  _feed(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const op = b0 & 0x0f;
      const fin = (b0 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const masked = (b1 & 0x80) !== 0;
      let mask = null;
      if (masked) { if (this.buf.length < off + 4) return; mask = this.buf.slice(off, off + 4); off += 4; }
      if (this.buf.length < off + len) return;
      let payload = this.buf.slice(off, off + len);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.buf = this.buf.slice(off + len);
      if (op === 8) { this.closed = true; return; }
      if (op === 9) { this._send(payload, 0xa); continue; }
      this.frags.push(payload);
      if (fin) {
        const msg = Buffer.concat(this.frags);
        this.frags = [];
        if (this.onmessage) this.onmessage(msg.toString());
      }
    }
  }
  _send(data, op = 0x1) {
    const p = Buffer.from(data);
    const mask = crypto.randomBytes(4);
    let head;
    if (p.length < 126) { head = Buffer.alloc(2); head[1] = 0x80 | p.length; }
    else if (p.length < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(p.length, 2); }
    else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(p.length), 2); }
    head[0] = 0x80 | op;
    const masked = Buffer.alloc(p.length);
    for (let i = 0; i < p.length; i++) masked[i] = p[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([head, mask, masked]));
  }
  send(obj) { this._send(JSON.stringify(obj)); }
}

(async () => {
  const targets = await getJson('/json');
  const page = targets.find(t => t.type === 'page') || targets[0];
  if (!page) throw new Error('no target');
  console.error('[target] ' + (page.url || '') + ' | ' + (page.title || ''));
  const ws = await wsConnect(page.webSocketDebuggerUrl);
  const id = 1;
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('evaluate timeout')), timeout);
    ws.onmessage = msg => {
      const m = JSON.parse(msg);
      if (m.id === id) {
        clearTimeout(timer);
        resolve(m);
      }
    };
    ws.send({
      id,
      method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }
    });
  });
  if (result.error) console.log(JSON.stringify({ cdpError: result.error }, null, 2));
  else if (result.result && result.result.exceptionDetails) {
    console.log(JSON.stringify({ exception: result.result.exceptionDetails }, null, 2));
  } else {
    const v = result.result && result.result.result;
    console.log(typeof v.value === 'undefined' ? JSON.stringify(v) : (typeof v.value === 'string' ? v.value : JSON.stringify(v.value, null, 2)));
  }
  process.exit(0);
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
