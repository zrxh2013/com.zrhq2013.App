#!/usr/bin/env node

const { Command } = require('commander');
const chalk = require('chalk');
const program = new Command();

const walletModule = require('./src/wallet');
const chainsModule = require('./src/chains');
const txModule = require('./src/transactions');
const interactive = require('./src/interactive');

program
  .name('wallet')
  .description('多链加密货币命令行钱包 - 支持Ethereum/BSC/Polygon/Arbitrum等EVM链')
  .version('1.0.0');

program
  .command('create')
  .description('创建新钱包')
  .option('-n, --name <name>', '钱包名称')
  .option('-p, --password <password>', '钱包密码')
  .action(async (options) => {
    await interactive.createWallet();
  });

program
  .command('import')
  .description('导入钱包（通过助记词或私钥）')
  .option('-n, --name <name>', '钱包名称')
  .option('-p, --password <password>', '钱包密码')
  .option('-m, --mnemonic <mnemonic>', '助记词')
  .option('-k, --private-key <key>', '私钥')
  .action(async (options) => {
    if (options.mnemonic || options.privateKey) {
      try {
        let { name, password, mnemonic, privateKey } = options;
        if (!name) name = 'imported-wallet';
        if (!password) {
          console.log('请提供密码参数 -p <password>');
          process.exit(1);
        }
        
        let wallet;
        if (mnemonic) {
          wallet = walletModule.mnemonicToWallet(mnemonic.trim());
        } else {
          wallet = walletModule.privateKeyToWallet(privateKey.trim());
        }
        
        const filePath = walletModule.saveWallet(name, wallet, password);
        console.log(`钱包导入成功: ${name} (${wallet.address})`);
        console.log(`保存路径: ${filePath}`);
      } catch (error) {
        console.error('导入失败:', error.message);
        process.exit(1);
      }
    } else {
      await interactive.importWallet();
    }
  });

program
  .command('list')
  .description('列出所有钱包')
  .action(() => {
    interactive.listWallets();
  });

program
  .command('delete [name]')
  .description('删除钱包')
  .action(async (name) => {
    if (name) {
      try {
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(`确定要删除钱包 "${name}" 吗？此操作不可恢复！(yes/no) `, (answer) => {
          if (answer.toLowerCase() === 'yes') {
            walletModule.deleteWallet(name);
            console.log(`钱包 "${name}" 已删除`);
          } else {
            console.log('已取消');
          }
          rl.close();
        });
      } catch (error) {
        console.error('删除失败:', error.message);
        process.exit(1);
      }
    } else {
      await interactive.deleteWallet();
    }
  });

program
  .command('chains')
  .description('列出支持的区块链网络')
  .action(() => {
    interactive.listChains();
  });

program
  .command('balance [name]')
  .description('查询余额')
  .option('-c, --chain <chain>', '区块链网络', 'ethereum')
  .option('-t, --token <address>', 'ERC20代币合约地址')
  .option('-p, --password <password>', '钱包密码')
  .action(async (name, options) => {
    if (name && options.password) {
      try {
        const walletData = walletModule.loadWallet(name, options.password);
        const chainInfo = chainsModule.getChain(options.chain);
        
        console.log(`\n查询 ${chainInfo.name} 网络余额...\n`);
        const balance = await txModule.getBalance(options.chain, walletData.address);
        console.log(`钱包: ${name}`);
        console.log(`地址: ${walletData.address}`);
        console.log(`网络: ${chainInfo.name}`);
        console.log(`\n原生币余额: ${balance.formatted} ${balance.symbol}`);
        
        if (options.token) {
          const tokenBalance = await txModule.getTokenBalance(options.chain, options.token, walletData.address);
          console.log(`代币余额: ${tokenBalance.formatted} ${tokenBalance.symbol}`);
        }
        console.log(`\n区块链浏览器: ${txModule.getAddressUrl(options.chain, walletData.address)}\n`);
      } catch (error) {
        console.error('查询失败:', error.message);
        process.exit(1);
      }
    } else {
      await interactive.checkBalance();
    }
  });

program
  .command('transfer [name]')
  .description('转账')
  .option('-c, --chain <chain>', '区块链网络', 'ethereum')
  .option('-t, --token <address>', 'ERC20代币合约地址')
  .option('-p, --password <password>', '钱包密码')
  .option('--to <address>', '接收地址')
  .option('-a, --amount <amount>', '转账数量')
  .action(async (name, options) => {
    if (name && options.password && options.to && options.amount) {
      try {
        const walletData = walletModule.loadWallet(name, options.password);
        const chainInfo = chainsModule.getChain(options.chain);
        
        console.log(`\n当前网络: ${chainInfo.name}`);
        const balance = await txModule.getBalance(options.chain, walletData.address);
        console.log(`当前余额: ${balance.formatted} ${balance.symbol}\n`);

        let tx;
        if (options.token) {
          tx = await txModule.sendToken(options.chain, walletData.wallet, options.token, options.to, options.amount);
        } else {
          tx = await txModule.sendNativeToken(options.chain, walletData.wallet, options.to, options.amount);
        }

        console.log(`交易已发送!`);
        console.log(`交易哈希: ${tx.hash}`);
        console.log(`区块链浏览器: ${txModule.getExplorerUrl(options.chain, tx.hash)}`);
      } catch (error) {
        console.error('转账失败:', error.message);
        process.exit(1);
      }
    } else {
      await interactive.transfer();
    }
  });

program
  .command('interactive')
  .alias('i')
  .description('进入交互模式（推荐）')
  .action(async () => {
    await interactive.startInteractive();
  });

if (process.argv.length === 2) {
  console.log(`
╔═══════════════════════════════════════╗
║     多链加密货币钱包 CLI v1.0.0       ║
║     Multi-chain Crypto Wallet         ║
╚═══════════════════════════════════════╝

使用 ${chalk.green('wallet interactive')} 或 ${chalk.green('wallet i')} 进入交互模式

命令列表:
  ${chalk.cyan('create')}      创建新钱包
  ${chalk.cyan('import')}      导入钱包（助记词/私钥）
  ${chalk.cyan('list')}        列出所有钱包
  ${chalk.cyan('balance')}     查询余额
  ${chalk.cyan('transfer')}    转账
  ${chalk.cyan('chains')}      列出支持的链
  ${chalk.cyan('delete')}      删除钱包
  ${chalk.cyan('interactive')} 交互模式
  ${chalk.cyan('help')}        显示帮助

运行 ${chalk.green('wallet <command> --help')} 查看命令详情
  `);
  process.exit(0);
}

program.parse(process.argv);
