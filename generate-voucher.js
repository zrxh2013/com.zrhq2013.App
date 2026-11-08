#!/usr/bin/env node
/**
 * TRON 链上交易存证 / 凭证生成器
 * 数据全部来自 TronScan API 真实链上记录
 *
 * 用法: node generate-voucher.js <交易哈希> [输出文件]
 */
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const TRONSCAN_API = 'https://apilist.tronscanapi.com/api/transaction-info';
const TRONSCAN_URL = 'https://tronscan.org/#/transaction';
const FONT_REGULAR = '/usr/share/fonts/opentype/noto-cjk-otf/NotoSansCJKsc-Regular.otf';
const FONT_BOLD = '/usr/share/fonts/opentype/noto-cjk-otf/NotoSansCJKsc-Bold.otf';

const C = {
  ink: '#1f2937', gray: '#6b7280', line: '#e5e7eb',
  brand: '#0f766e', warn: '#b91c1c', warnBg: '#fef2f2',
  headBg: '#0f766e', zebra: '#f8fafc',
};

function fmtNum(v) {
  const [i, d] = String(v).split('.');
  const withCommas = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return d ? `${withCommas}.${d}` : withCommas;
}
function fmtDate(ms) {
  const d = new Date(Number(ms));
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function sun(n) { return fmtNum((Number(n || 0) / 1e6).toFixed(6)); }

async function fetchTx(hash) {
  // 支持离线模式：TX_JSON 指向已通过 curl 获取的真实 TronScan 响应文件
  if (process.env.TX_JSON) {
    const data = JSON.parse(fs.readFileSync(process.env.TX_JSON, 'utf-8'));
    if (!data || !data.hash) throw new Error('本地 JSON 中未找到该交易');
    if (data.hash.toLowerCase() !== hash.toLowerCase()) {
      throw new Error('本地 JSON 的交易哈希与输入不一致');
    }
    return data;
  }
  const res = await fetch(`${TRONSCAN_API}?hash=${hash}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VoucherGenerator/1.0)' },
  });
  if (!res.ok) throw new Error(`TronScan API HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !data.hash) throw new Error('未找到该交易（哈希可能不存在或尚未上链）');
  return data;
}

function parseTx(d) {
  const contractType = d.contractType || 0;
  const token = d.tokenTransferInfo || {};
  const isTrc20 = contractType === 31 && token && token.symbol;
  const isTrx = contractType === 1;

  const cost = d.cost || {};
  const feeTrx = Number(cost.net_fee || 0) + Number(cost.energy_fee || 0) + Number(cost.multi_sign_fee || 0);

  const riskContract = !!(d.contractInfo && Object.values(d.contractInfo).some(v => v && v.risk));
  const risky = !!d.riskTransaction || riskContract;

  let details;
  if (isTrc20) {
    const decimals = Number(token.decimals || 6);
    const amount = Number(token.amount_str || 0) / Math.pow(10, decimals);
    details = {
      kind: 'TRC20 代币转账',
      tokenName: token.name || '(未命名代币)',
      symbol: token.symbol || '',
      decimals,
      amount: fmtNum(amount.toFixed(decimals)),
      contract: token.contract_address || d.toAddress,
      from: token.from_address || d.ownerAddress,
      to: token.to_address || '',
    };
  } else if (isTrx) {
    const cd = d.contractData || {};
    const amount = Number(cd.amount || 0) / 1e6;
    details = {
      kind: 'TRX 转账',
      tokenName: 'TRX',
      symbol: 'TRX',
      decimals: 6,
      amount: fmtNum(amount.toFixed(6)),
      contract: '-',
      from: d.ownerAddress,
      to: cd.to_address || d.toAddress,
    };
  } else {
    details = {
      kind: `其他合约调用 (type ${contractType})`,
      tokenName: '-', symbol: '', decimals: 0, amount: '-',
      contract: d.toAddress, from: d.ownerAddress, to: '-',
    };
  }

  return {
    hash: d.hash,
    block: d.block,
    confirmations: d.confirmations,
    time: fmtDate(d.timestamp),
    status: d.contractRet || (d.confirmed ? 'SUCCESS' : 'PENDING'),
    confirmed: !!d.confirmed,
    memo: d.data || '',
    feeTrx: sun(feeTrx),
    band: sun(cost.net_fee || 0),
    energy: sun(cost.energy_fee || 0),
    risky,
    riskTransaction: !!d.riskTransaction,
    riskContract,
    details,
  };
}

function generatePDF(t, outPath) {
  const doc = new PDFDocument({ size: 'A4', margin: 0 });
  doc.pipe(fs.createWriteStream(outPath));
  doc.registerFont('Noto', FONT_REGULAR);
  doc.registerFont('Bold', FONT_BOLD);

  const W = 595.28, M = 50, CW = W - M * 2;
  const isCustomToken = t.details.contract !== '-' && t.details.symbol !== 'TRX';

  // 顶部色带
  doc.rect(0, 0, W, 92).fill(C.headBg);
  doc.fillColor('#ffffff').font('Bold').fontSize(22).text('TRON 链上交易存证', M, 28);
  doc.font('Noto').fontSize(10).fillColor('#d1fae5')
     .text('TRON On-Chain Transaction Attestation', M, 58);

  let y = 118;

  // 风险提示
  if (t.risky) {
    const tip = `风险提示：TronScan 将${t.riskTransaction ? '本交易' : ''}${t.riskTransaction && t.riskContract ? '及' : ''}${t.riskContract ? '该代币合约' : ''}标记为风险。` +
      `本凭证仅如实记录链上数据，不构成任何付款、兑付或价值证明。`;
    const th = doc.font('Noto').fontSize(9.5).heightOfString(tip, { width: CW - 24 });
    doc.roundedRect(M, y, CW, th + 24, 6).fill(C.warnBg);
    doc.rect(M, y, 4, th + 24).fill(C.warn);
    doc.fillColor(C.warn).font('Bold').fontSize(10).text('⚠ 风险交易', M + 14, y + 8);
    doc.font('Noto').fontSize(9.5).fillColor('#7f1d1d').text(tip, M + 14, y + 22, { width: CW - 28 });
    y += th + 34;
  }

  // 代币性质说明
  if (isCustomToken) {
    const note = `本交易涉及的代币为 “${t.details.tokenName}”（符号 ${t.details.symbol}），合约地址 ${t.details.contract}。` +
      `该代币为链上自定义发行的 TRC20 代币，并非 USDT，也不等同于美元（USD）法定货币，不具备美元偿付能力。`;
    const nh = doc.font('Noto').fontSize(9).heightOfString(note, { width: CW - 24 });
    doc.roundedRect(M, y, CW, nh + 18, 6).fill('#fffbeb');
    doc.fillColor('#92400e').font('Noto').fontSize(9).text(note, M + 12, y + 9, { width: CW - 24 });
    y += nh + 28;
  }

  // 分组表格
  const rows = [
    ['交易哈希', t.hash],
    ['区块高度', String(t.block)],
    ['交易时间', t.time],
    ['确认状态', `${t.status}　（确认数 ${t.confirmations}）`],
    ['交易类型', t.details.kind],
  ];

  const transferRows = [
    ['代币名称', `${t.details.tokenName}${t.details.symbol ? `（${t.details.symbol}）` : ''}`],
    ['代币合约', t.details.contract],
    ['转账数量', `${t.details.amount}${t.details.symbol ? ' ' + t.details.symbol : ''}`],
    ['转出地址', t.details.from],
    ['转入地址', t.details.to],
  ];

  const feeRows = [
    ['带宽费用', `${t.band} TRX`],
    ['能量费用', `${t.energy} TRX`],
    ['总费用', `${t.feeTrx} TRX`],
    ['交易备注', t.memo ? t.memo : '无'],
  ];

  const drawSection = (title, list) => {
    doc.fillColor(C.brand).font('Bold').fontSize(11).text(title, M, y);
    y += 18;
    list.forEach((r, i) => {
      const rowH = 24;
      if (i % 2 === 0) doc.rect(M, y, CW, rowH).fill(C.zebra);
      doc.fillColor(C.gray).font('Noto').fontSize(9).text(r[0], M + 10, y + 7, { width: 92 });
      doc.fillColor(C.ink).font('Noto').fontSize(9).text(String(r[1] || '-'), M + 110, y + 7, { width: CW - 120 });
      doc.moveTo(M, y + rowH).lineTo(M + CW, y + rowH).lineWidth(0.5).strokeColor(C.line).stroke();
      y += rowH;
    });
    y += 14;
  };

  drawSection('交易基本信息', rows);
  drawSection('转账详情', transferRows);
  drawSection('网络费用与备注', feeRows);

  // 链上核验
  doc.fillColor(C.brand).font('Bold').fontSize(11).text('链上核验', M, y);
  y += 18;
  doc.fillColor(C.ink).font('Noto').fontSize(9)
     .text('请在 TronScan 输入交易哈希进行核验，链上数据与本凭证逐项一致：', M, y, { width: CW });
  y += 16;
  doc.fillColor('#1d4ed8').font('Noto').fontSize(9)
     .text(`${TRONSCAN_URL}/${t.hash}`, M, y, { width: CW, link: `${TRONSCAN_URL}/${t.hash}`, underline: true });
  y += 28;

  // 免责声明
  doc.moveTo(M, y).lineTo(M + CW, y).lineWidth(0.5).strokeColor(C.line).stroke();
  y += 10;
  doc.fillColor(C.gray).font('Noto').fontSize(8).text(
    '免责声明：本凭证由程序依据 TronScan 公开接口返回的链上数据自动生成，仅用于交易记录留档与核验，不构成付款证明、' +
    '资产权属证明或任何形式的担保。链上数据最终以区块链浏览器显示为准。',
    M, y, { width: CW }
  );

  doc.end();
}

(async () => {
  const hash = (process.argv[2] || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hash)) {
    console.error('错误：交易哈希格式不正确（需为 64 位十六进制字符串）');
    process.exit(1);
  }
  const out = process.argv[3] || path.join('/workspace', `voucher-${hash.slice(0, 12)}.pdf`);

  try {
    const raw = await fetchTx(hash);
    const t = parseTx(raw);
    generatePDF(t, out);
    await new Promise(r => setTimeout(r, 600));
    console.log('✅ 凭证已生成:', out);
    console.log('   交易类型:', t.details.kind);
    console.log('   代币:', `${t.details.tokenName} (${t.details.symbol})`, '总量:', t.details.amount);
    console.log('   状态:', t.status, '| 风险:', t.risky ? '是' : '否');
  } catch (e) {
    console.error('生成失败:', e.message);
    process.exit(1);
  }
})();
