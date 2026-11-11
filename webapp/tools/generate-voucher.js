/* ============================================================
 * TRON 链上转账凭证生成器（信托提存留档）
 * 数据全部来自 TronScan API 真实链上记录，不接受手工填写金额
 * 用法：node tools/generate-voucher.js <64位交易哈希> [输出文件.pdf] [mainnet|nile]
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const FONT_REGULAR = '/usr/share/fonts/opentype/noto-cjk-otf/NotoSansCJKsc-Regular.otf';
const FONT_BOLD = '/usr/share/fonts/opentype/noto-cjk-otf/NotoSansCJKsc-Bold.otf';

const NETWORKS = {
  mainnet: { api: 'https://apilist.tronscanapi.com', web: 'https://tronscan.org/#/transaction' },
  nile: { api: 'https://nile.tronscan.org', web: 'https://nile.tronscan.org/#/transaction' }
};

async function fetchTransactionInfo(txHash, network) {
  const url = `${NETWORKS[network].api}/api/transaction-info?hash=${txHash}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`TronScan API HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data || !data.hash) throw new Error('链上不存在该交易（或节点尚未同步）');
  return data;
}

const CONTRACT_TYPES = {
  1: 'TRX 原生转账', 31: 'TRC20 代币转账', 57: '资源代理（DelegateResource）',
  59: '撤销资源代理', 11: '解冻资产', 12: '提取解冻资产', 4: '投票', 33: 'TRC20 授权'
};

function extractDetails(data) {
  const tokenInfo = data.tokenTransferInfo || {};
  const contractData = data.contractData || {};
  const isTRC20 = data.contractType === 31 && tokenInfo.symbol;
  const isTransfer = isTRC20 || data.contractType === 1;
  const decimals = Number(tokenInfo.decimals ?? 6);
  const raw = isTRC20 ? tokenInfo.amount_str || tokenInfo.amount : contractData.amount;
  const amount = raw != null ? Number(raw) / Math.pow(10, decimals) : null;
  return {
    isTransfer,
    type: isTRC20 ? 'TRC20 代币转账'
      : (CONTRACT_TYPES[data.contractType] || `合约类型 ${data.contractType}（非标准转账）`),
    symbol: isTRC20 ? tokenInfo.symbol : (data.contractType === 1 ? 'TRX' : '--'),
    amount,
    from: isTRC20 ? tokenInfo.from_address : contractData.owner_address,
    to: isTRC20 ? tokenInfo.to_address : contractData.to_address || contractData.receiver_address,
    contract: isTRC20 ? tokenInfo.contract_address : null,
    memo: data.contractData && data.contractData.data ? Buffer.from(data.contractData.data, 'hex').toString('utf8') : ''
  };
}

function generatePDF(data, details, txHash, outPath, network) {
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  doc.pipe(fs.createWriteStream(outPath));
  doc.registerFont('Noto', FONT_REGULAR);
  doc.registerFont('Noto-Bold', FONT_BOLD);
  doc.font('Noto');

  const W = doc.page.width - 96;
  const fmtTime = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });
  const fmtTrx = (sun) => (sun ? (sun / 1_000_000).toFixed(6) : '0');

  // 标题
  doc.rect(0, 0, doc.page.width, 92).fill('#0f2742');
  doc.fillColor('#ffffff').font('Noto-Bold').fontSize(20).text('TRON 链上提存转账凭证', 48, 30);
  doc.font('Noto').fontSize(10).fillColor('#e9dcc0')
    .text(`信托账户完整公证提存平台 · ${NETWORKS[network].api.includes('nile') ? 'Nile 测试网' : 'TRON 主网'} · 数据来源 TronScan 实时链上记录`, 48, 62);
  doc.moveDown(2.2).fillColor('#1f2937');

  const section = (title) => {
    doc.moveDown(0.8).font('Noto-Bold').fontSize(13).fillColor('#0f2742').text(title);
    doc.moveTo(48, doc.y + 2).lineTo(48 + W, doc.y + 2).strokeColor('#b08a3e').lineWidth(1.2).stroke();
    doc.moveDown(0.5).font('Noto').fontSize(10.5).fillColor('#1f2937');
  };
  const row = (k, v, mono) => {
    doc.font('Noto-Bold').fillColor('#6b7280').text(k, { continued: false });
    doc.font(mono ? 'Noto' : 'Noto').fillColor('#111827').text(String(v ?? '--'), { indent: 8 });
    doc.moveDown(0.25);
  };

  section('一、交易基本信息');
  row('交易哈希', txHash, true);
  row('区块高度', data.block ?? '--');
  row('交易时间', data.timestamp ? fmtTime(data.timestamp) : '--');
  row('确认数', data.confirmations ?? '--');
  row('交易状态', data.contractRet || (data.confirmed ? 'SUCCESS' : 'PENDING'));
  row('交易类型', details.type);

  section('二、转账详情');
  row('代币 / 币种', details.symbol);
  row('转账金额', details.amount != null ? `${details.amount} ${details.symbol}` : '--');
  row('转出地址', details.from, true);
  row('转入地址', details.to, true);
  if (details.contract) row('合约地址', details.contract, true);

  section('三、网络费用');
  const cost = data.cost || {};
  row('带宽费用 (TRX)', fmtTrx(cost.net_fee || 0));
  row('能量费用 (TRX)', fmtTrx(cost.energy_fee || 0));
  row('总费用 (TRX)', fmtTrx((cost.net_fee || 0) + (cost.energy_fee || 0)));

  section('四、交易备注（Memo 链上存证）');
  if (details.memo) {
    doc.font('Noto').fontSize(9.5).text(details.memo, { width: W });
  } else doc.text('（本笔交易无 Memo）');

  section('五、链上核验');
  const link = `${NETWORKS[network].web}/${txHash}`;
  doc.fillColor('#1d4ed8').text(link, { link, underline: true, width: W });
  doc.fillColor('#374151').fontSize(9.5).moveDown(0.4)
    .text('核验方式：打开上述 TronScan 链接，比对金额、地址、时间与 Memo 指纹；任何字段不一致即说明凭证或文书被篡改。', { width: W });

  section('六、公证文书防伪通道（官方）');
  doc.fontSize(9.5).fillColor('#374151')
    .text('① 司法部中国委托公证（香港）核查系统：https://clshkl.moj.gov.cn/', { width: W })
    .text('② 中国法律服务网 12348：https://zwfw.12348.gov.cn/ → 委托公证文书（香港）核查', { width: W })
    .text('③ 中国委托公证人协会 CAAO：https://www.caao.org.hk ｜ (852) 2877 8775', { width: W })
    .text('④ 出具律所核验：叶谢邓律师行 (852) 6888-9999 ｜ https://www.ytt.com.hk/zh-hans/enquiry-form/', { width: W });

  doc.moveDown(1).fontSize(8.5).fillColor('#6b7280')
    .text('免责声明：本凭证由系统根据 TronScan API 实时返回的链上数据自动生成，仅反映生成时刻的链上记录，不构成投资建议；公证文书之法律效力以中国委托公证人签署并经中法服加章转递的正本为准。', { width: W });

  doc.end();
}

(async () => {
  const txHash = process.argv[2];
  const outArg = process.argv[3];
  const network = process.argv[4] === 'nile' ? 'nile' : 'mainnet';
  if (!txHash || !/^[0-9a-fA-F]{64}$/.test(txHash)) {
    console.error('用法: node tools/generate-voucher.js <64位交易哈希> [输出文件.pdf] [mainnet|nile]');
    process.exit(1);
  }
  for (const f of [FONT_REGULAR, FONT_BOLD]) {
    if (!fs.existsSync(f)) { console.error('缺少中文字体：' + f); process.exit(1); }
  }
  const outPath = path.resolve(outArg || `voucher-${txHash.slice(0, 12)}.pdf`);
  console.log('→ 从 TronScan 获取链上数据…');
  const data = await fetchTransactionInfo(txHash, network);
  const details = extractDetails(data);
  if (!details.isTransfer) {
    console.warn('⚠ 该交易为「' + details.type + '」，非 TRX/TRC20 转账，金额字段将留空，仍生成核验凭证。');
  }
  console.log('→ 生成 PDF：' + outPath);
  generatePDF(data, details, txHash, outPath, network);
  setTimeout(() => {
    const size = fs.statSync(outPath).size;
    console.log(`✔ 完成：${outPath}（${(size / 1024).toFixed(1)} KB）`);
  }, 600);
})().catch((err) => { console.error('✖', err.message); process.exit(1); });
