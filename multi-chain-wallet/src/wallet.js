const { ethers } = require('ethers');
const bip39 = require('bip39');
const crypto = require('crypto-js');
const fs = require('fs');
const path = require('path');

const WALLET_DIR = path.join(__dirname, '..', 'wallets');

function initWalletDir() {
  if (!fs.existsSync(WALLET_DIR)) {
    fs.mkdirSync(WALLET_DIR, { recursive: true });
  }
}

function generateMnemonic() {
  return bip39.generateMnemonic(256);
}

function mnemonicToWallet(mnemonic, pathIndex = 0) {
  const hdPath = `m/44'/60'/0'/0/${pathIndex}`;
  const wallet = ethers.Wallet.fromMnemonic(mnemonic, hdPath);
  return wallet;
}

function privateKeyToWallet(privateKey) {
  return new ethers.Wallet(privateKey);
}

function encryptWallet(wallet, password) {
  const encryptKey = crypto.SHA256(password).toString();
  const data = {
    address: wallet.address,
    privateKey: wallet.privateKey,
    mnemonic: wallet.mnemonic ? wallet.mnemonic.phrase : null
  };
  const jsonStr = JSON.stringify(data);
  const encrypted = crypto.AES.encrypt(jsonStr, encryptKey).toString();
  return encrypted;
}

function decryptWallet(encryptedData, password) {
  try {
    const encryptKey = crypto.SHA256(password).toString();
    const bytes = crypto.AES.decrypt(encryptedData, encryptKey);
    const decrypted = bytes.toString(crypto.enc.Utf8);
    const data = JSON.parse(decrypted);
    let wallet;
    if (data.mnemonic) {
      wallet = mnemonicToWallet(data.mnemonic);
    } else {
      wallet = privateKeyToWallet(data.privateKey);
    }
    return wallet;
  } catch (error) {
    throw new Error('密码错误或钱包文件损坏');
  }
}

function saveWallet(name, wallet, password) {
  initWalletDir();
  const encrypted = encryptWallet(wallet, password);
  const filePath = path.join(WALLET_DIR, `${name}.json`);
  const fileData = {
    name,
    address: wallet.address,
    encrypted,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(filePath, JSON.stringify(fileData, null, 2));
  return filePath;
}

function loadWallet(name, password) {
  const filePath = path.join(WALLET_DIR, `${name}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`钱包 "${name}" 不存在`);
  }
  const fileData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const wallet = decryptWallet(fileData.encrypted, password);
  return {
    name: fileData.name,
    address: fileData.address,
    wallet
  };
}

function listWallets() {
  initWalletDir();
  const files = fs.readdirSync(WALLET_DIR);
  return files
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(WALLET_DIR, f), 'utf8'));
      return {
        name: data.name,
        address: data.address,
        createdAt: data.createdAt
      };
    });
}

function deleteWallet(name) {
  const filePath = path.join(WALLET_DIR, `${name}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`钱包 "${name}" 不存在`);
  }
  fs.unlinkSync(filePath);
  return true;
}

function isValidAddress(address) {
  return ethers.utils.isAddress(address);
}

function formatEther(wei) {
  return ethers.utils.formatEther(wei);
}

function parseEther(ether) {
  return ethers.utils.parseEther(ether);
}

module.exports = {
  generateMnemonic,
  mnemonicToWallet,
  privateKeyToWallet,
  encryptWallet,
  decryptWallet,
  saveWallet,
  loadWallet,
  listWallets,
  deleteWallet,
  isValidAddress,
  formatEther,
  parseEther
};
