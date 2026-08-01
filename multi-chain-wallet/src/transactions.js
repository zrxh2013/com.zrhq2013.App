const { ethers } = require('ethers');
const { getChain, getProvider, ERC20_ABI } = require('./chains');

async function getBalance(chainKey, address) {
  const chain = getChain(chainKey);
  const provider = getProvider(chainKey);
  const balance = await provider.getBalance(address);
  return {
    wei: balance,
    formatted: ethers.utils.formatUnits(balance, chain.decimals),
    symbol: chain.symbol
  };
}

async function getTokenInfo(chainKey, tokenAddress) {
  const provider = getProvider(chainKey);
  const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    tokenContract.name(),
    tokenContract.symbol(),
    tokenContract.decimals(),
    tokenContract.totalSupply()
  ]);

  return {
    address: tokenAddress,
    name,
    symbol,
    decimals,
    totalSupply: ethers.utils.formatUnits(totalSupply, decimals)
  };
}

async function getTokenBalance(chainKey, tokenAddress, ownerAddress) {
  const provider = getProvider(chainKey);
  const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  
  const [balance, decimals, symbol] = await Promise.all([
    tokenContract.balanceOf(ownerAddress),
    tokenContract.decimals(),
    tokenContract.symbol()
  ]);

  return {
    wei: balance,
    formatted: ethers.utils.formatUnits(balance, decimals),
    symbol,
    decimals
  };
}

async function estimateGas(chainKey, from, to, value, data = '0x') {
  const provider = getProvider(chainKey);
  const gasEstimate = await provider.estimateGas({
    from,
    to,
    value,
    data
  });
  return gasEstimate;
}

async function getGasPrice(chainKey) {
  const provider = getProvider(chainKey);
  const gasPrice = await provider.getGasPrice();
  return {
    wei: gasPrice,
    gwei: ethers.utils.formatUnits(gasPrice, 'gwei')
  };
}

async function sendNativeToken(chainKey, wallet, toAddress, amount, options = {}) {
  const chain = getChain(chainKey);
  const provider = getProvider(chainKey);
  const connectedWallet = wallet.connect(provider);

  if (!ethers.utils.isAddress(toAddress)) {
    throw new Error('无效的接收地址');
  }

  const value = ethers.utils.parseUnits(amount.toString(), chain.decimals);
  
  const balance = await provider.getBalance(wallet.address);
  if (balance.lt(value)) {
    throw new Error(`余额不足，当前余额: ${ethers.utils.formatUnits(balance, chain.decimals)} ${chain.symbol}`);
  }

  const tx = {
    to: toAddress,
    value,
    chainId: chain.chainId
  };

  if (options.gasLimit) {
    tx.gasLimit = options.gasLimit;
  } else {
    tx.gasLimit = await estimateGas(chainKey, wallet.address, toAddress, value);
  }

  if (options.gasPrice) {
    tx.gasPrice = ethers.utils.parseUnits(options.gasPrice.toString(), 'gwei');
  }

  const transaction = await connectedWallet.sendTransaction(tx);
  return transaction;
}

async function sendToken(chainKey, wallet, tokenAddress, toAddress, amount, options = {}) {
  const provider = getProvider(chainKey);
  const connectedWallet = wallet.connect(provider);
  const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, connectedWallet);

  if (!ethers.utils.isAddress(toAddress)) {
    throw new Error('无效的接收地址');
  }

  const decimals = await tokenContract.decimals();
  const value = ethers.utils.parseUnits(amount.toString(), decimals);

  const balance = await tokenContract.balanceOf(wallet.address);
  if (balance.lt(value)) {
    const symbol = await tokenContract.symbol();
    throw new Error(`代币余额不足，当前余额: ${ethers.utils.formatUnits(balance, decimals)} ${symbol}`);
  }

  const data = tokenContract.interface.encodeFunctionData('transfer', [toAddress, value]);
  
  const tx = {
    to: tokenAddress,
    data,
    chainId: getChain(chainKey).chainId
  };

  if (options.gasLimit) {
    tx.gasLimit = options.gasLimit;
  } else {
    tx.gasLimit = await estimateGas(chainKey, wallet.address, tokenAddress, 0, data);
  }

  if (options.gasPrice) {
    tx.gasPrice = ethers.utils.parseUnits(options.gasPrice.toString(), 'gwei');
  }

  const transaction = await connectedWallet.sendTransaction(tx);
  return transaction;
}

async function waitForTransaction(chainKey, txHash, confirmations = 1) {
  const provider = getProvider(chainKey);
  const receipt = await provider.waitForTransaction(txHash, confirmations);
  return receipt;
}

function getExplorerUrl(chainKey, txHash) {
  const chain = getChain(chainKey);
  return `${chain.explorer}/tx/${txHash}`;
}

function getAddressUrl(chainKey, address) {
  const chain = getChain(chainKey);
  return `${chain.explorer}/address/${address}`;
}

module.exports = {
  getBalance,
  getTokenInfo,
  getTokenBalance,
  estimateGas,
  getGasPrice,
  sendNativeToken,
  sendToken,
  waitForTransaction,
  getExplorerUrl,
  getAddressUrl
};
