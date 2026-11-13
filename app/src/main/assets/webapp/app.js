/* ============================================================
 * 信托账户完整公证提存平台 · 前端主逻辑
 * 合规要点：
 *  1) 公证防伪通道仅使用官方实查字典（司法部/12348/CAAO/TRONSCAN）
 *  2) 不虚构公证书编号、不虚构交易哈希；无私钥时走离线提存包
 *  3) 私钥仅存在于服务端环境变量，前端永不接触
 * ============================================================ */
'use strict';

/* ---------- 常量 ---------- */
const STORE_KEY = 'trustEscrow.sessions.v1';
const ACTIVE_KEY = 'trustEscrow.activeId.v1';
const APP_VERSION = '1.0.0';
const BURN_ADDRESS = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'; // TRON 黑洞地址，memo 锚定 1 sun
const SUN = 1_000_000;

const NETWORKS = {
  mainnet: {
    label: 'TRON 主网',
    grid: 'https://api.trongrid.io',
    scanApi: 'https://apilist.tronscanapi.com',
    scanTx: 'https://tronscan.io/#/transaction/'
  },
  nile: {
    label: 'Nile 测试网',
    grid: 'https://nile.trongrid.io',
    scanApi: 'https://nile.tronscan.org',
    scanTx: 'https://nile.tronscan.org/#/transaction/'
  },
  mock: {
    label: '模拟链（本地演示）',
    simulated: true,
    grid: '',
    scanApi: '',
    scanTx: ''
  }
};

/* 真实防伪通道字典（2026-09 WebSearch + cURL 双重实查，hk-notary-anti-forgery 技能规范） */
const DEFAULT_NOTARY = {
  org: '叶谢邓律师行 Y.T. Ting & Y.T. HO',
  notaryLabel: '中国委托公证人（香港）· 叶谢邓律师行',
  certNo: '', // 公证人执业编号由签署现场回填，前端不虚构
  notaryHotline: '(852) 6888-9999',
  notaryHotline2: '(852) 9109-9999',
  mainlandHotline: '131-4389-6699',
  chinaAttestingPage: 'https://www.ytt.so/',
  enquiryForm: 'https://www.ytt.com.hk/zh-hans/enquiry-form/',
  gzOffice: { phone: '(86) 020-2881 6688', address: '广州天河区林和西路161号中泰国际广场B座2003室' },
  antiForgery: {
    mojVerify: 'https://clshkl.moj.gov.cn/',
    gov12348: 'https://zwfw.12348.gov.cn/',
    caao: 'https://www.caao.org.hk/',
    caaoHotline: '(852) 2877 8775',
    mojHotline: '+852 2827 9700',
    tronscan: 'https://tronscan.io/#/transaction/',
    etherscan: 'https://etherscan.io/tx/'
  }
};

/* ---------- 工具 ---------- */
const $ = (id) => document.getElementById(id);
const nowIso = () => new Date().toISOString();
const ymd = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const ymdCompact = (d = new Date()) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const rand6 = () => String(Math.floor(100000 + Math.random() * 900000));

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove('show'), ms);
}

function setInvalid(fieldEl, invalid) {
  if (!fieldEl) return;
  const wrap = fieldEl.closest('.field');
  if (wrap) wrap.classList.toggle('invalid', invalid);
}

/* 纯 JS SHA-256 兜底（当 crypto.subtle 因非安全上下文不可用时启用，如部分旧 WebView） */
function sha256Fallback(input) {
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const rotr = (n, x) => (x >>> n) | (x << (32 - n));
  const src = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const bytes = Array.from(src);
  const l = bytes.length;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const bitLen = l * 8;
  // 注意 JS 移位 ≥32 会回绕，高 4 字节直接置 0（本应用 memo ≤900 字节，长度远低于 2^32）
  for (let i = 7; i >= 0; i--) bytes.push(i < 4 ? ((bitLen >>> (i * 8)) & 0xff) : 0);
  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const W = new Uint32Array(64);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      W[i] = (bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) |
             (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(7, W[i - 15]) ^ rotr(18, W[i - 15]) ^ (W[i - 15] >>> 3);
      const s1 = rotr(17, W[i - 2]) ^ rotr(19, W[i - 2]) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  return H.map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
}

async function sha256Bytes(input) {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  if (globalThis.crypto && globalThis.crypto.subtle) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  }
  const hex = sha256Fallback(data);
  return Uint8Array.from(hex.match(/.{2}/g).map((h) => parseInt(h, 16)));
}

async function sha256Hex(text) {
  const b = await sha256Bytes(text);
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

/* Base58 字典与 TRON 地址 Base58Check 校验 */
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(str) {
  let num = 0n;
  for (const ch of str) {
    const idx = B58_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('非法 Base58 字符');
    num = num * 58n + BigInt(idx);
  }
  const hex = num.toString(16).padStart(50, '0'); // 25 字节
  const leadingOnes = (str.match(/^1+/) || [''])[0].length;
  return '00'.repeat(leadingOnes) + hex.slice(leadingOnes * 2);
}
async function validateTronAddress(addr) {
  if (typeof addr !== 'string') return { ok: false, reason: 'not_string' };
  if (addr.length !== 34) return { ok: false, reason: `长度=${addr.length}（须为34）` };
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr)) {
    const bad = [];
    for (const ch of addr) { if (!B58_ALPHABET.includes(ch) && ch !== 'T') bad.push(`U+${ch.charCodeAt(0).toString(16)}`); }
    return { ok: false, reason: '含非Base58字符 ' + bad.join(',') };
  }
  try {
    const rawHex = base58Decode(addr); // 含 0x41 前缀 + 20 字节地址 + 4 字节校验
    if (rawHex.length !== 50) return { ok: false, reason: '解码长度=' + rawHex.length };
    const payload = Uint8Array.from(
      rawHex.slice(0, 42).match(/.{2}/g).map((h) => parseInt(h, 16))
    );
    const checksum = rawHex.slice(42);
    const h1 = await sha256Bytes(payload);
    const h2 = await sha256Bytes(h1);
    const calc = Array.from(h2.slice(0, 4))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    return calc === checksum ? { ok: true } : { ok: false, reason: `校验和不符 calc=${calc} want=${checksum}` };
  } catch (err) {
    return { ok: false, reason: '异常:' + err.message };
  }
}
async function isValidTronAddress(addr) { return (await validateTronAddress(addr)).ok; }

function downloadText(filename, text, mime = 'application/json') {
  // Android WebView 内置桥接：写入应用专属目录（assets 模式下 blob 下载不可靠）
  if (window.EscrowBridge && typeof window.EscrowBridge.saveText === 'function') {
    const r = window.EscrowBridge.saveText(filename, text);
    if (typeof r === 'string' && r.startsWith('ERROR')) toast('保存失败：' + r);
    else toast('已保存到设备：' + r, 4200);
    return;
  }
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
}

async function fetchWithTimeout(url, opts = {}, ms = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 会话存储 ---------- */
function loadSessions() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
  catch { return {}; }
}
function saveSessions(map) { localStorage.setItem(STORE_KEY, JSON.stringify(map)); }
function persist(s) {
  const map = loadSessions();
  s.updatedAt = nowIso();
  map[s.id] = s;
  saveSessions(map);
  localStorage.setItem(ACTIVE_KEY, s.id);
  renderSessionList();
}
let session = null;

function newSession() {
  const d = new Date();
  session = {
    id: 'sess_' + Date.now().toString(36) + rand6(),
    caseNo: `TE${ymdCompact(d)}-${rand6()}`,
    createdAt: nowIso(), updatedAt: nowIso(), step: 1,
    trust: {}, notarization: {}, escrow: {}, chain: {}, finalized: false
  };
  localStorage.setItem(ACTIVE_KEY, session.id);
  persist(session);
  $('case-chip').textContent = '案件编号：' + session.caseNo;
  return session;
}

function renderSessionList() {
  const wrap = $('session-list');
  const map = loadSessions();
  const list = Object.values(map).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!list.length) {
    wrap.innerHTML = '<div class="hint">暂无历史案件（数据仅保存在本设备浏览器）。</div>';
    return;
  }
  wrap.innerHTML = list.map((s) => {
    const mockTag = (s.escrow && s.escrow.simulated) ? '<span class="tag net-mock">模拟</span> ' : '';
    const st = s.chain && s.chain.transferTx ? '<span class="tag ok">已上链</span>'
      : (s.escrow && s.escrow.memoHex ? '<span class="tag pending">待广播</span>' : '');
    return `<div class="session-item" data-id="${s.id}">
      <div>
        <div class="si-main">${mockTag}${s.trust.trustName || '未命名信托'} ${st}</div>
        <div class="si-sub">${s.caseNo} ｜ ${(s.trust.amount || '--')} ${s.trust.ccy || ''} ｜ ${s.updatedAt.replace('T', ' ').slice(0, 16)}</div>
      </div>
      <div style="color:#b08a3e;font-weight:800;">恢复 ›</div>
    </div>`;
  }).join('');
  wrap.querySelectorAll('.session-item').forEach((el) => {
    el.addEventListener('click', () => restoreSession(el.dataset.id));
  });
}

function restoreSession(id) {
  const s = loadSessions()[id];
  if (!s) return toast('案件不存在或已被清除');
  session = s;
  $('case-chip').textContent = '案件编号：' + s.caseNo;
  hydrateForms();
  goStep(Math.min(s.step || 1, 4), true);
  toast('已恢复案件 ' + s.caseNo);
}

/* ---------- 步骤切换 ---------- */
function goStep(n, skipValidate = false) {
  if (!skipValidate && n > (session.step || 1)) {
    if (!validateStep(session.step || 1)) return;
  }
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  $('panel-' + n).classList.add('active');
  document.querySelectorAll('.step-dot').forEach((dot) => {
    const k = Number(dot.dataset.step);
    dot.classList.toggle('active', k === n);
    dot.classList.toggle('done', k < n);
  });
  session.step = n;
  persist(session);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (n === 4) finalizeSession();
}

/* ---------- 步骤 1：表单读写与校验 ---------- */
function readTrustForm() {
  session.trust = {
    trustName: $('f-trust-name').value.trim(),
    grantor: $('f-grantor').value.trim(),
    grantorId: $('f-grantor-id').value.trim(),
    phone: $('f-phone').value.trim(),
    trustee: $('f-trustee').value.trim(),
    beneficiary: $('f-beneficiary').value.trim(),
    beneficiaryId: $('f-beneficiary-id').value.trim(),
    ccy: $('f-ccy').value,
    amount: $('f-amount').value.trim(),
    term: $('f-term').value.trim(),
    setupDate: $('f-setupdate').value,
    purpose: $('f-purple') ? $('f-purple').value.trim() : $('f-purpose').value.trim()
  };
}
function hydrateForms() {
  const t = session.trust || {};
  const map = {
    'f-trust-name': t.trustName, 'f-grantor': t.grantor, 'f-grantor-id': t.grantorId,
    'f-phone': t.phone, 'f-trustee': t.trustee, 'f-beneficiary': t.beneficiary,
    'f-beneficiary-id': t.beneficiaryId, 'f-ccy': t.ccy, 'f-amount': t.amount,
    'f-term': t.term, 'f-setupdate': t.setupDate, 'f-purpose': t.purpose
  };
  Object.entries(map).forEach(([id, v]) => { if (v !== undefined && $(id)) $(id).value = v; });
  const n = session.notarization || {};
  if (n.certNo) $('f-cert-no').value = n.certNo;
  if (n.notaryCertNo) $('f-notary-cert-no').value = n.notaryCertNo;
  if (n.fingerprint) {
    $('fp-output').style.display = 'block';
    $('fp-value').textContent = n.fingerprint;
    $('fp-time').textContent = n.fpTime;
  }
  const e = session.escrow || {};
  if (e.network) $('f-network').value = e.network;
  if (e.wallet) $('f-wallet').value = e.wallet;
  if (e.amount) $('f-escrow-amount').value = e.amount;
  if (e.ccy) $('f-escrow-ccy').value = e.ccy;
  if (e.sender) $('f-sender').value = e.sender;
  if (e.memoObj) {
    $('memo-preview').textContent = JSON.stringify(e.memoObj, null, 2);
    $('escrow-action-card').style.display = 'block';
  }
  applyNetworkUI();
}

function validateStep(step) {
  let ok = true;
  const mark = (id, bad) => { setInvalid($(id), bad); if (bad) ok = false; };
  if (step === 1) {
    readTrustForm();
    const t = session.trust;
    mark('f-trust-name', !t.trustName);
    mark('f-grantor', !t.grantor);
    mark('f-grantor-id', !t.grantorId);
    mark('f-phone', !/^1[3-9]\d{9}$/.test(t.phone));
    mark('f-trustee', !t.trustee);
    mark('f-beneficiary', !t.beneficiary);
    mark('f-beneficiary-id', !t.beneficiaryId);
    mark('f-amount', !(Number(t.amount) > 0));
    mark('f-term', !t.term);
    mark('f-setupdate', !t.setupDate);
    mark('f-purpose', !t.purpose);
    if (ok) {
      persist(session);
      $('f-escrow-ccy').value = t.ccy;
      $('f-escrow-amount').value = t.amount;
    } else toast('请修正标红字段后再继续');
  }
  if (step === 2) {
    if (!session.notarization.fingerprint) { toast('请先生成文书指纹（SHA-256）'); ok = false; }
    if (!$('notary-declare').checked) { toast('请勾选申请人声明'); ok = false; }
    if (ok) {
      session.notarization.items = Array.from(document.querySelectorAll('.notary-item:checked'))
        .map((c) => c.parentElement.textContent.trim());
      session.notarization.declared = true;
      session.notarization.notaryCertNo = $('f-notary-cert-no').value.trim();
      persist(session);
    }
  }
  if (step === 3) {
    if (!session.escrow.memoObj) { toast('请先生成提存 Memo 与离线提存包'); ok = false; }
  }
  return ok;
}

/* ---------- 步骤 2：公证编号 + 文书指纹 ---------- */
function ensureCertNo() {
  if (!session.notarization.certNo) {
    session.notarization.certNo = `CN-HK-${new Date().getFullYear()}-${rand6()}`;
    $('f-cert-no').value = session.notarization.certNo;
  }
  return session.notarization.certNo;
}

async function generateFingerprint() {
  readTrustForm();
  if (!session.trust.trustName || !(Number(session.trust.amount) > 0)) {
    toast('请先完整填写步骤 1 的信托信息'); goStep(1); return;
  }
  const certNo = ensureCertNo();
  const payload = {
    app: 'trust-escrow-notary',
    version: APP_VERSION,
    caseNo: session.caseNo,
    certNo,
    trust: session.trust,
    notaryOrg: DEFAULT_NOTARY.org,
    generatedAt: nowIso()
  };
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const fp = await sha256Hex(canonical);
  session.notarization.fingerprint = fp;
  session.notarization.fpTime = nowIso();
  session.notarization.canonical = canonical;
  persist(session);
  $('fp-output').style.display = 'block';
  $('fp-value').textContent = fp;
  $('fp-time').textContent = session.notarization.fpTime;
  $('fp-output').scrollIntoView({ behavior: 'smooth', block: 'center' });
  toast('文书指纹已生成并写入案件');
}

/* ---------- 步骤 3：memo、提存包、链上交互 ---------- */
function toSun(amount) { return Math.round(Number(amount) * SUN); }

async function buildMemo() {
  readTrustForm();
  const wallet = $('f-wallet').value.trim();
  const amount = $('f-escrow-amount').value.trim();
  const network = $('f-network').value;
  const walletCheck = await validateTronAddress(wallet);
  if (!walletCheck.ok) {
    setInvalid($('f-wallet'), true);
    return toast('收款钱包地址校验失败：' + walletCheck.reason, 4200);
  }
  setInvalid($('f-wallet'), false);
  if (!(Number(amount) > 0)) { setInvalid($('f-escrow-amount'), true); return toast('提存金额不正确'); }
  setInvalid($('f-escrow-amount'), false);

  const memoObj = {
    ty: 'TRUST_ESCROW',
    v: 1,
    net: network === 'mock' ? 'SIM' : (network === 'mainnet' ? 'TRON' : 'NILE'),
    caseNo: session.caseNo,
    certNo: ensureCertNo(),
    fp: session.notarization.fingerprint,
    ben: session.trust.beneficiary,
    to: wallet,
    amt: toSun(amount),
    ccy: session.trust.ccy,
    ts: Date.now()
  };
  const memoHex = new TextEncoder().encode(JSON.stringify(memoObj))
    .reduce((hex, b) => hex + b.toString(16).padStart(2, '0'), '');

  session.escrow = {
    network, wallet, amount, ccy: session.trust.ccy,
    sender: $('f-sender').value.trim(),
    simulated: network === 'mock',
    memoObj, memoHex, memoBytes: memoHex.length / 2
  };
  persist(session);
  $('memo-preview').textContent = JSON.stringify(memoObj, null, 2) +
    `\n\n// memoHex (${memoHex.length / 2} bytes):\n` + memoHex;
  $('escrow-action-card').style.display = 'block';
  logChain('✔ Memo 已生成（' + (memoHex.length / 2) + ' 字节，限制 900）');
  writeOfflinePackage();
  detectServer();
  toast('提存 Memo 与离线提存包已生成');
}

function writeOfflinePackage() {
  const e = session.escrow;
  const isMock = e.simulated === true;
  const pkg = {
    packageType: 'TRUST_ESCROW_OFFLINE_PACKAGE',
    version: APP_VERSION,
    exportedAt: nowIso(),
    simulated: isMock,
    simulationNotice: isMock ? '本提存包基于本地模拟链 SIMCHAIN 生成，不含真实链上交易，不具存证法律效力，仅供流程演示' : undefined,
    caseNo: session.caseNo,
    notarization: {
      certNo: session.notarization.certNo,
      notaryOrg: DEFAULT_NOTARY.org,
      fingerprint: session.notarization.fingerprint
    },
    network: e.network,
    fullHost: isMock ? 'SIMCHAIN-LOCAL（本地模拟，无真实节点）' : NETWORKS[e.network].grid,
    transfer: { to: e.wallet, amountSun: toSun(e.amount), token: e.ccy, memoHex: e.memoHex },
    anchor: { to: BURN_ADDRESS, amountSun: 1, memoHex: e.memoHex },
    memoObject: e.memoObj,
    broadcastScript: isMock
      ? "// 模拟链广播（本地服务，无需私钥与真实网络）\n" +
        "// POST /api/anchor { network:'mock', memoHex } 或 POST /api/transfer { network:'mock', to, amountSun, memoHex }\n" +
        "// 查询：GET /api/mock/tx?hash=<txid>；重置：POST /api/mock/reset"
      : "// 受托人广播示例（私钥通过环境变量 TRON_PRIVATE_KEY 注入，切勿硬编码）\n" +
        "const { TronWeb } = require('tronweb');\n" +
        `const tw = new TronWeb({ fullHost: '${NETWORKS[e.network].grid}', privateKey: process.env.TRON_PRIVATE_KEY });\n` +
        "(async () => {\n" +
        "  const tx = await tw.transactionBuilder.sendTrx(process.env.TO_ADDRESS, Number(process.env.AMOUNT_SUN), undefined, { data: process.env.MEMO_HEX });\n" +
        "  const signed = await tw.trx.sign(tx);\n" +
        "  const r = await tw.trx.sendRawTransaction(signed);\n" +
        "  console.log('txID:', r.txid);\n" +
        "})();"
  };
  e.packageFile = `escrow-package-${session.caseNo}.json`;
  e.packageJson = JSON.stringify(pkg, null, 2);
  persist(session);
}

let serverOnline = false;
async function detectServer() {
  const el = $('server-status');
  try {
    const r = await fetchWithTimeout('/api/health', {}, 4000);
    serverOnline = r.ok;
    const info = r.ok ? await r.json().catch(() => ({})) : {};
    el.innerHTML = serverOnline
      ? `提存服务：<span class="tag ok">在线</span> ${info.keyConfigured ? '· 已配置签名私钥，可直接上链' : '· 未配置私钥（真实链只读，模拟链不受影响）'}${info.mockAvailable ? ' · <span class="tag net-mock">模拟链可用</span>' : ''}`
      : '提存服务不可用';
  } catch {
    serverOnline = false;
    el.innerHTML = '提存服务：<span class="tag pending">离线模式</span>（已生成离线提存包，可由受托人配置服务后广播，系统不会虚构交易哈希）';
  }
}

/* ---------- 模拟区块链钱包（SIMCHAIN 本地演示） ---------- */
function isMockNetwork() { return $('f-network').value === 'mock'; }

function applyNetworkUI() {
  const mock = isMockNetwork();
  $('mock-wallet-card').style.display = mock ? 'block' : 'none';
  if (mock) refreshMockWallet();
}

async function refreshMockWallet() {
  try {
    const r = await fetchWithTimeout('/api/mock/wallet', {}, 6000);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    $('mock-signer-addr').textContent = j.signer.address;
    $('mock-wallet-addr').textContent = j.wallet.address;
    $('mock-signer-balance').textContent = j.signer.balanceTrx + ' TRX（模拟）';
    $('mock-wallet-balance').textContent = j.wallet.balanceTrx + ' TRX（模拟）';
    $('mock-block-height').textContent = j.height;
    // 仅在空值或当前已是模拟案件时自动填充，避免覆盖用户在真实网络填的地址
    if (!$('f-wallet').value.trim() || (session.escrow && session.escrow.simulated)) $('f-wallet').value = j.wallet.address;
    if (!$('f-sender').value.trim() || (session.escrow && session.escrow.simulated)) $('f-sender').value = j.signer.address;
    return j;
  } catch (err) {
    toast('模拟钱包加载失败：' + err.message);
    return null;
  }
}

async function mockFaucet() {
  const btn = $('btn-mock-faucet'); btn.disabled = true;
  try {
    const r = await fetchWithTimeout('/api/mock/faucet', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountTrx: 1000 })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '领取失败');
    toast('已领取 1000 模拟 TRX（演示资产，无真实价值）');
    await refreshMockWallet();
  } catch (err) { toast(err.message); }
  finally { btn.disabled = false; }
}

async function mockReset() {
  if (!confirm('确认重置模拟链？将清空全部模拟交易与余额并重新生成模拟钱包，不影响任何真实数据。')) return;
  try {
    const r = await fetchWithTimeout('/api/mock/reset', { method: 'POST' });
    const j = await r.json();
    if (!r.ok) throw new Error((j && j.error) || '重置失败');
    $('f-wallet').value = j.wallet.address;
    $('f-sender').value = j.signer.address;
    await refreshMockWallet();
    toast('模拟链已重置');
  } catch (err) { toast(err.message); }
}

async function openMockExplorer(hash) {
  const body = $('mock-modal-body');
  body.textContent = '加载中…';
  $('mock-modal').classList.add('show');
  try {
    const r = await fetchWithTimeout(`/api/mock/tx?hash=${encodeURIComponent(hash)}`, {}, 6000);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '查询失败');
    const rows = [
      ['模拟链 ID', j.chainId],
      ['交易哈希', j.txID, true],
      ['区块高度', '#' + j.blockNumber + '（确认数 ' + j.confirmations + '）'],
      ['交易类型', j.kind === 'ANCHOR' ? 'Memo 锚定（1 sun 黑洞）' : '提存转账'],
      ['发送方', j.from, true],
      ['接收方', j.to, true],
      ['金额', (j.amountSun / SUN) + ' TRX（模拟）'],
      ['手续费', (j.feeSun / SUN) + ' TRX（模拟）'],
      ['合约结果', j.contractRet + ' · confirmed=' + j.confirmed],
      ['时间', new Date(j.timestamp).toLocaleString()]
    ];
    let memoPretty = j.memoText || '';
    try { memoPretty = JSON.stringify(JSON.parse(memoPretty), null, 2); } catch { /* 非 JSON 则原样展示 */ }
    body.innerHTML = rows.map(([k, v, mono]) =>
      `<div class="mv-row"><span class="k">${k}</span><span class="v ${mono ? 'mono' : ''}">${v}</span></div>`).join('') +
      (j.memoHex ? `<div class="mv-row"><span class="k">链上 Memo</span></div><pre>${escapeHtml(memoPretty)}</pre>` : '');
  } catch (err) {
    body.textContent = '加载失败：' + err.message;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function logChain(line) {
  const box = $('chain-log');
  box.style.display = 'block';
  const d = new Date().toLocaleTimeString();
  box.textContent += `[${d}] ${line}\n`;
  box.scrollTop = box.scrollHeight;
}

async function queryBalance() {
  const addr = $('f-sender').value.trim();
  const network = $('f-network').value;
  const check = await validateTronAddress(addr);
  if (!check.ok) return toast('发送方地址格式不正确：' + check.reason);
  const out = $('balance-out');
  out.textContent = '查询中…';
  try {
    if (network === 'mock') {
      const r = await fetchWithTimeout(`/api/mock/balance?address=${encodeURIComponent(addr)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '查询失败');
      out.innerHTML = `模拟钱包余额：<b>${j.balanceTrx} TRX</b>（<span class="tag net-mock">SIMCHAIN 模拟</span>，无真实价值）`;
      return;
    }
    if (serverOnline) {
      const r = await fetchWithTimeout(`/api/balance?address=${encodeURIComponent(addr)}&network=${network}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '查询失败');
      out.innerHTML = `链上余额：<b>${j.balanceTrx} TRX</b>（${NETWORKS[network].label}，未激活地址显示 0）`;
    } else {
      const r = await fetchWithTimeout(`${NETWORKS[network].grid}/wallet/getaccount`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addr, visible: true })
      });
      const j = await r.json();
      const trx = (j.balance || 0) / SUN;
      out.innerHTML = `链上余额：<b>${trx} TRX</b>（${NETWORKS[network].label}，直连 TronGrid）`;
    }
  } catch (err) {
    out.textContent = '余额查询失败：' + err.message;
  }
}

async function callAnchor() {
  if (!serverOnline) return toast('离线模式：请使用已下载的提存包由受托人广播');
  const e = session.escrow;
  const btn = $('btn-anchor'); btn.disabled = true;
  logChain(e.simulated ? '→ 请求【模拟链】锚定存证（memo 写入模拟黑洞地址 1 sun）…' : '→ 请求锚定存证（memo 写入黑洞地址 1 sun）…');
  try {
    const r = await fetchWithTimeout('/api/anchor', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ network: e.network, memoHex: e.memoHex })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '锚定失败');
    session.chain.anchorTx = j.txid;
    if (j.simulated) session.chain.simulated = true;
    persist(session);
    logChain((e.simulated ? '✔【模拟】锚定交易已生成：' : '✔ 锚定交易已广播：') + j.txid);
    toast(e.simulated ? '模拟锚定存证已生成（非真实上链）' : '锚定存证已上链，开始轮询确认…');
    pollConfirmation(j.txid);
  } catch (err) {
    logChain('✖ ' + err.message);
    toast(err.message);
  } finally { btn.disabled = false; }
}

async function callTransfer() {
  if (!serverOnline) return toast('离线模式：请使用已下载的提存包由受托人广播');
  const e = session.escrow;
  const tip = e.simulated
    ? `【模拟演示】确认向模拟钱包 ${e.wallet} 提存 ${e.amount} ${e.ccy}？该操作仅发生在本地模拟链，不转移真实资产。`
    : `确认向 ${e.wallet} 提存 ${e.amount} ${e.ccy}？该操作不可撤销。`;
  if (!confirm(tip)) return;
  const btn = $('btn-transfer'); btn.disabled = true;
  logChain(e.simulated ? '→ 请求【模拟链】正式提存转账…' : '→ 请求正式提存转账…');
  try {
    const r = await fetchWithTimeout('/api/transfer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        network: e.network, to: e.wallet,
        amountSun: toSun(e.amount), token: e.ccy, memoHex: e.memoHex
      })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '转账失败');
    session.chain.transferTx = j.txid;
    session.chain.status = 'broadcast';
    if (j.simulated) session.chain.simulated = true;
    persist(session);
    logChain((e.simulated ? '✔【模拟】提存交易已生成：' : '✔ 提存交易已广播：') + j.txid);
    toast(e.simulated ? '模拟提存交易已生成（非真实转账）' : '提存交易已广播，等待链上确认…');
    pollConfirmation(j.txid);
  } catch (err) {
    logChain('✖ ' + err.message);
    toast(err.message);
  } finally { btn.disabled = false; }
}

async function pollMockConfirmation(txHash) {
  logChain('→ 查询 SIMCHAIN 模拟链交易状态…');
  try {
    const r = await fetchWithTimeout(`/api/mock/tx?hash=${encodeURIComponent(txHash)}`, {}, 6000);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '查询失败');
    session.chain = {
      ...session.chain,
      status: 'confirmed', simulated: true,
      block: j.blockNumber, contractRet: j.contractRet,
      confirmed: true, confirmations: j.confirmations,
      lastPolled: nowIso()
    };
    persist(session);
    logChain(`✔【模拟】区块 #${j.blockNumber} ｜ contractRet=${j.contractRet} ｜ 确认数=${j.confirmations}（本地模拟数据，非真实链上确认）`);
    await refreshMockWallet();
    return true;
  } catch (err) {
    logChain('✖ 模拟链查询失败：' + err.message);
    return false;
  }
}

async function pollConfirmation(txHash) {
  const e = session.escrow;
  if (e.network === 'mock') return pollMockConfirmation(txHash);
  const base = NETWORKS[e.network].scanApi;
  logChain('→ 轮询 TronScan 确认状态…');
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetchWithTimeout(`${base}/api/transaction-info?hash=${txHash}`, {}, 8000);
      if (r.ok) {
        const j = await r.json();
        if (j && j.hash) {
          session.chain = {
            ...session.chain,
            status: j.confirmed ? 'confirmed' : 'broadcast',
            block: j.block, contractRet: j.contractRet,
            confirmed: j.confirmed, confirmations: j.confirmations,
            lastPolled: nowIso()
          };
          persist(session);
          logChain(`✔ 区块 ${j.block} ｜ contractRet=${j.contractRet} ｜ 确认数=${j.confirmations ?? 0}`);
          if (j.confirmed) return true;
        }
      }
    } catch { /* 节点同步延迟，继续重试 */ }
    await new Promise((res) => setTimeout(res, 4000));
  }
  logChain('… 暂未取得确认，可稍后点「手动刷新」');
  return false;
}

/* ---------- 步骤 4：完成页 + 防伪按钮（技能 Step 4.2 规范） ---------- */
function finalizeSession() {
  const s = session;
  const t = s.trust || {}, n = s.notarization || {}, e = s.escrow || {}, c = s.chain || {};
  const isMock = e.network === 'mock' || c.simulated === true;
  const netTag = e.network
    ? (isMock
      ? '<span class="tag net-mock">模拟链 · 演示</span>'
      : `<span class="tag ${e.network === 'mainnet' ? 'net-main' : 'net-nile'}">${NETWORKS[e.network].label}</span>`)
    : '';
  const chainStatus = isMock
    ? (c.transferTx ? '<span class="tag net-mock">模拟已确认（非真实链上）</span>' : '<span class="tag pending">模拟待执行</span>')
    : (c.transferTx
      ? (c.confirmed ? '<span class="tag ok">已确认</span>' : '<span class="tag pending">已广播待确认</span>')
      : '<span class="tag pending">离线提存包待广播</span>');
  $('summary-list').innerHTML = [
    ['案件编号', s.caseNo],
    ['环境性质', isMock ? '🧪 本地模拟演示（不具真实存证效力）' : '真实 TRON 网络链上存证'],
    ['信托名称', t.trustName || '--'],
    ['委托人', `${t.grantor || '--'}（${t.grantorId || '--'}）`],
    ['受益人', `${t.beneficiary || '--'}（${t.beneficiaryId || '--'}）`],
    ['受托人', t.trustee || '--'],
    ['提存标的', `${t.amount || '--'} ${t.ccy || ''}`],
    ['公证申请编号', n.certNo || '--'],
    ['文书指纹 SHA-256', n.fingerprint || '--', true],
    ['提存网络', netTag || '--'],
    ['收款钱包', e.wallet || '--', true],
    ['锚定交易', c.anchorTx || '（未执行）', true],
    ['提存交易', c.transferTx || (isMock ? '（待执行模拟交易）' : '（待广播，无虚构哈希）'), true],
    ['链上状态', chainStatus],
    ['区块高度', c.block ?? '--']
  ].map(([k, v, mono]) =>
    `<li><span class="k">${k}</span><span class="v ${mono ? 'mono' : ''}">${v}</span></li>`).join('');

  /* ===== 防伪卡填充（hk-notary-anti-forgery Step 4.2） ===== */
  const antiCard = $('done-antiforgery-card');
  antiCard.style.display = 'block';
  const af = DEFAULT_NOTARY.antiForgery;
  $('done-verify-certno').textContent = n.certNo || '公证人签署后回填';
  const dt = new Date(); const dateStr = ymd(dt);
  $('done-verify-date').textContent = dateStr;
  const zdNo = `ZD-${dt.getFullYear()}-${(n.certNo || '').replace(/\D/g, '').slice(-8).padStart(8, '0')}`;
  $('done-verify-zhuandi').textContent = `${zdNo}（办理中，中法服 3-5 工作日加章后最终确定）`;
  const safe = (x) => encodeURIComponent(String(x || ''));
  const q = `certno=${safe(n.certNo)}&date=${safe(dateStr)}&zdno=${safe(zdNo)}` +
    `&org=${safe(DEFAULT_NOTARY.org)}&notary=${safe(n.notaryCertNo || DEFAULT_NOTARY.certNo)}` +
    `&signer=${safe(t.grantor || '')}`;
  $('done-v-moj').href = `${af.mojVerify}?${q}`;
  $('done-v-12348').href = `${af.gov12348}?service=${safe('委托公证文书（香港）核查')}&${q}`;
  $('done-v-caao').href = `${af.caao}contacts?${q}`;
  const chainBtn = $('done-v-chain');
  if (isMock) {
    // 模拟链：哈希仅能在本地模拟浏览器查看，禁止指向 TRONSCAN（否则构成伪造核验入口）
    const mockHash = c.transferTx || c.anchorTx || '';
    chainBtn.removeAttribute('href');
    chainBtn.href = '#';
    chainBtn.dataset.mockHash = mockHash;
    chainBtn.querySelector('b').textContent = mockHash
      ? '🧪 模拟链交易查看（本地演示数据，非 TRONSCAN）'
      : '🧪 模拟链（尚未生成模拟交易）';
  } else {
    delete chainBtn.dataset.mockHash;
    if (c.transferTx || c.anchorTx) {
      const hash = c.transferTx || c.anchorTx;
      chainBtn.href = (NETWORKS[e.network]?.scanTx || af.tronscan) + hash;
      chainBtn.querySelector('b').textContent = '区块链独立核验（TRONSCAN）';
    } else {
      chainBtn.href = af.tronscan;
      chainBtn.querySelector('b').textContent = '区块链独立核验（TRONSCAN 首页）';
    }
  }

  $('btn-open-declaration').href = `beneficiary-declaration-official.html?id=${encodeURIComponent(s.id)}`;
  s.finalized = true;
  persist(s);
}

function downloadPackage() {
  const e = session.escrow || {};
  if (!e.packageJson) return toast('请先在步骤 3 生成提存包');
  downloadText(e.packageFile, e.packageJson);
  toast('提存包已下载：' + e.packageFile);
}

function voucherHint() {
  if (session.escrow && session.escrow.simulated) {
    return toast('模拟链交易无真实链上记录，不能生成 TRONSCAN 转账凭证；请在真实网络完成提存后使用', 4200);
  }
  const hash = session.chain && session.chain.transferTx;
  const cmd = hash
    ? `node tools/generate-voucher.js ${hash} voucher-${session.caseNo}.pdf`
    : 'node tools/generate-voucher.js <64位交易哈希> [输出文件名.pdf]';
  toast('链上确认后在服务端运行：' + cmd, 4200);
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  $('btn-to-2').addEventListener('click', () => { readTrustForm(); goStep(2); });
  $('btn-to-3').addEventListener('click', () => goStep(3));
  $('btn-to-4').addEventListener('click', () => goStep(4));
  document.querySelectorAll('[data-goto]').forEach((b) =>
    b.addEventListener('click', () => goStep(Number(b.dataset.goto), true)));
  $('btn-gen-fp').addEventListener('click', generateFingerprint);
  $('btn-build-memo').addEventListener('click', buildMemo);
  $('btn-paste-wallet').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) { $('f-wallet').value = text.trim(); toast('已粘贴钱包地址'); }
      else toast('剪贴板为空');
    } catch {
      toast('请长按输入框手动粘贴（浏览器未授权剪贴板）');
    }
  });
  $('btn-balance').addEventListener('click', queryBalance);
  $('btn-anchor').addEventListener('click', callAnchor);
  $('btn-transfer').addEventListener('click', callTransfer);
  $('btn-poll').addEventListener('click', () => {
    const h = session.chain.transferTx || session.chain.anchorTx;
    h ? pollConfirmation(h).then(() => toast('刷新完成')) : toast('暂无交易哈希');
  });
  $('btn-download-package').addEventListener('click', downloadPackage);
  $('btn-voucher-hint').addEventListener('click', voucherHint);
  $('btn-mock-faucet').addEventListener('click', mockFaucet);
  $('btn-mock-refresh').addEventListener('click', () => refreshMockWallet().then(() => toast('模拟钱包已刷新')));
  $('btn-mock-reset').addEventListener('click', mockReset);
  $('mock-modal-close').addEventListener('click', () => $('mock-modal').classList.remove('show'));
  $('mock-modal').addEventListener('click', (ev) => { if (ev.target === $('mock-modal')) $('mock-modal').classList.remove('show'); });
  $('done-v-chain').addEventListener('click', (ev) => {
    const h = ev.currentTarget.dataset.mockHash;
    if (h) { ev.preventDefault(); openMockExplorer(h); }
  });
  $('btn-new-case').addEventListener('click', () => { newSession(); resetForms(); goStep(1, true); toast('已创建新案件'); });
  $('f-network').addEventListener('change', () => {
    if (session.escrow) { session.escrow = {}; persist(session); }
    $('memo-preview').textContent = '尚未生成';
    $('escrow-action-card').style.display = 'none';
    applyNetworkUI();
  });
}

function resetForms() {
  document.querySelectorAll('input[type="text"], input:not([type]), textarea, input.mono')
    .forEach((el) => { if (!el.readOnly) el.value = ''; });
  $('fp-output').style.display = 'none';
  $('memo-preview').textContent = '尚未生成';
  $('escrow-action-card').style.display = 'none';
  $('balance-out').textContent = '';
  document.querySelectorAll('.field.invalid').forEach((f) => f.classList.remove('invalid'));
  applyNetworkUI();
}

/* ---------- 启动 ---------- */
(function init() {
  bindEvents();
  renderSessionList();
  const activeId = localStorage.getItem(ACTIVE_KEY);
  const map = loadSessions();
  if (activeId && map[activeId]) {
    session = map[activeId];
    $('case-chip').textContent = '案件编号：' + session.caseNo;
    hydrateForms();
  } else {
    newSession();
  }
  $('f-setupdate').value = ymd();
  if (session && session.trust && session.trust.setupDate) $('f-setupdate').value = session.trust.setupDate;
  applyNetworkUI();
})();
