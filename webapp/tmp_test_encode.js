const { TronWeb } = require('tronweb');
const tw = new TronWeb({ fullHost: 'https://api.trongrid.io', privateKey: process.env.TRON_PRIVATE_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' });

const encVarint = (n) => { let v = BigInt(n); const out = []; while (v >= 0x80n) { out.push(Number(v & 0x7fn) | 0x80); v >>= 7n; } out.push(Number(v)); return Buffer.from(out); };
const encBytes = (tag, buf) => Buffer.concat([Buffer.from([tag]), encVarint(buf.length), buf]);
const encVarintField = (tag, n) => Buffer.concat([Buffer.from([tag]), encVarint(n)]);
const hex = (s) => Buffer.from(String(s).replace(/^0x/, ''), 'hex');

const buildRawData = (r, transferBytes) => {
  const typeUrl = Buffer.from('type.googleapis.com/protocol.TransferContract', 'utf8');
  const any = Buffer.concat([encBytes(0x0a, typeUrl), encBytes(0x12, transferBytes)]);
  const contract = Buffer.concat([encVarintField(0x08, 1), encBytes(0x12, any)]);
  return Buffer.concat([
    encBytes(0x0a, hex(r.ref_block_bytes)),
    encBytes(0x22, hex(r.ref_block_hash)),
    encVarintField(0x40, r.expiration),
    encBytes(0x5a, contract),
    encVarintField(0x70, r.timestamp),
  ]);
};

(async () => {
  const BURN = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
  const tx = await tw.transactionBuilder.sendTrx(BURN, 1);
  const v = tx.raw_data.contract[0].parameter.value;
  const r = tx.raw_data;
  const transferNoData = Buffer.concat([
    encBytes(0x0a, hex(v.owner_address)),
    encBytes(0x12, hex(v.to_address)),
    encVarintField(0x18, v.amount),
  ]);
  const mineNoData = buildRawData(r, transferNoData).toString('hex');
  console.log('MATCH no-data:', mineNoData === tx.raw_data_hex);
  console.log('mine:', mineNoData);
  console.log('tron:', tx.raw_data_hex);

  const memoHex = Buffer.from('{"ty":"test"}').toString('hex');
  const transferWithData = Buffer.concat([
    encBytes(0x0a, hex(v.owner_address)),
    encBytes(0x12, hex(v.to_address)),
    encVarintField(0x18, v.amount),
    encBytes(0x22, hex(memoHex)),
  ]);
  const rawWithData = buildRawData(r, transferWithData);
  console.log('data embedded in raw:', rawWithData.toString('hex').includes(memoHex));

  // sha256 via tronweb utils
  const rawBytes = rawWithData;
  const txID = tw.utils.ethersUtils.sha256(rawBytes).replace(/^0x/, '');
  console.log('txID len:', txID.length);
  console.log('sha256 available:', typeof tw.utils.ethersUtils.sha256);
})();
