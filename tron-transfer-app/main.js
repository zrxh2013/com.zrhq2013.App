'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { WalletService } = require('./lib/tron');

const wallet = new WalletService('mainnet');
let win = null;
let recordsFile = '';

function loadRecords() {
  try {
    return JSON.parse(fs.readFileSync(recordsFile, 'utf8'));
  } catch (_) {
    return [];
  }
}

function saveRecords(list) {
  fs.writeFileSync(recordsFile, JSON.stringify(list, null, 2), 'utf8');
}

function addRecord(rec) {
  const list = loadRecords();
  list.unshift(rec);
  saveRecords(list.slice(0, 2000));
}

function ok(data) {
  return { ok: true, data };
}

function fail(err) {
  return { ok: false, error: (err && err.message) || String(err) };
}

function wrap(fn) {
  return async (_evt, payload) => {
    try {
      return ok(await fn(payload || {}));
    } catch (e) {
      return fail(e);
    }
  };
}

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 780,
    minWidth: 860,
    minHeight: 640,
    title: 'TRON 转账工具',
    backgroundColor: '#0f1720',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  recordsFile = path.join(app.getPath('userData'), 'transfers.json');
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle(
  'wallet:state',
  wrap(async () => ({
    network: wallet.network,
    unlocked: wallet.unlocked,
    address: wallet.address,
  }))
);

ipcMain.handle(
  'wallet:network',
  wrap(async ({ network }) => {
    const r = wallet.setNetwork(network);
    return { ...r, unlocked: wallet.unlocked };
  })
);

ipcMain.handle(
  'wallet:unlock',
  wrap(async ({ privateKey }) => {
    const address = wallet.unlock(privateKey);
    return { address };
  })
);

ipcMain.handle(
  'wallet:lock',
  wrap(async () => {
    wallet.lock();
    return { locked: true };
  })
);

ipcMain.handle(
  'wallet:balances',
  wrap(async () => wallet.getBalances())
);

ipcMain.handle(
  'wallet:estimate',
  wrap(async (p) => wallet.estimate(p))
);

ipcMain.handle(
  'wallet:send',
  wrap(async (p) => {
    const result = await wallet.send(p);
    addRecord({
      time: new Date().toISOString(),
      network: wallet.network,
      type: p.type,
      from: wallet.address,
      to: p.to,
      amount: p.amount,
      memo: p.memo || '',
      txid: result.txid,
      explorer: result.explorer,
      status: 'SUCCESS',
    });
    return result;
  })
);

ipcMain.handle(
  'records:list',
  wrap(async () => loadRecords())
);

ipcMain.handle(
  'records:export',
  wrap(async () => {
    const list = loadRecords();
    if (!list.length) throw new Error('暂无记录可导出');
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '导出转账记录',
      defaultPath: `tron-transfers-${Date.now()}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const header = ['时间', '网络', '类型', '发送方', '接收方', '金额', '备注', '交易哈希', '状态'];
    const rows = list.map((r) =>
      [r.time, r.network, r.type, r.from, r.to, r.amount, r.memo, r.txid, r.status].map(esc).join(',')
    );
    fs.writeFileSync(filePath, '\ufeff' + [header.map(esc).join(','), ...rows].join('\r\n'), 'utf8');
    return { canceled: false, filePath, count: list.length };
  })
);
