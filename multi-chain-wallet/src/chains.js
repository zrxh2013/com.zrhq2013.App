const { ethers } = require('ethers');

const CHAINS = {
  ethereum: {
    name: 'Ethereum',
    symbol: 'ETH',
    chainId: 1,
    rpcUrl: 'https://eth.llamarpc.com',
    explorer: 'https://etherscan.io',
    decimals: 18
  },
  bsc: {
    name: 'BNB Smart Chain',
    symbol: 'BNB',
    chainId: 56,
    rpcUrl: 'https://bsc-dataseed.binance.org',
    explorer: 'https://bscscan.com',
    decimals: 18
  },
  polygon: {
    name: 'Polygon',
    symbol: 'MATIC',
    chainId: 137,
    rpcUrl: 'https://polygon-rpc.com',
    explorer: 'https://polygonscan.com',
    decimals: 18
  },
  arbitrum: {
    name: 'Arbitrum One',
    symbol: 'ETH',
    chainId: 42161,
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    explorer: 'https://arbiscan.io',
    decimals: 18
  },
  optimism: {
    name: 'Optimism',
    symbol: 'ETH',
    chainId: 10,
    rpcUrl: 'https://mainnet.optimism.io',
    explorer: 'https://optimistic.etherscan.io',
    decimals: 18
  },
  avalanche: {
    name: 'Avalanche C-Chain',
    symbol: 'AVAX',
    chainId: 43114,
    rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
    explorer: 'https://snowtrace.io',
    decimals: 18
  },
  sepolia: {
    name: 'Sepolia Testnet',
    symbol: 'ETH',
    chainId: 11155111,
    rpcUrl: 'https://rpc.sepolia.org',
    explorer: 'https://sepolia.etherscan.io',
    decimals: 18
  },
  goerli: {
    name: 'Goerli Testnet',
    symbol: 'ETH',
    chainId: 5,
    rpcUrl: 'https://goerli.blockpi.network/v1/rpc/public',
    explorer: 'https://goerli.etherscan.io',
    decimals: 18
  }
};

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)'
];

function getChain(chainKey) {
  const chain = CHAINS[chainKey.toLowerCase()];
  if (!chain) {
    throw new Error(`不支持的链: ${chainKey}，支持的链: ${Object.keys(CHAINS).join(', ')}`);
  }
  return chain;
}

function getProvider(chainKey) {
  const chain = getChain(chainKey);
  return new ethers.providers.JsonRpcProvider(chain.rpcUrl);
}

function getSupportedChains() {
  return Object.entries(CHAINS).map(([key, value]) => ({
    key,
    name: value.name,
    symbol: value.symbol,
    chainId: value.chainId
  }));
}

module.exports = {
  CHAINS,
  ERC20_ABI,
  getChain,
  getProvider,
  getSupportedChains
};
