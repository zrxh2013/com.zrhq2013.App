const inquirer = require('inquirer');
const chalk = require('chalk');
const walletModule = require('./wallet');
const chainsModule = require('./chains');
const txModule = require('./transactions');

async function createWallet() {
  try {
    const answers = await inquirer.prompt([
      { type: 'input', name: 'name', message: '请输入钱包名称:', default: 'my-wallet' },
      { type: 'password', name: 'password', message: '请输入钱包密码（至少8位）:', mask: '*', validate: v => v.length >= 8 || '密码至少8位' },
      { type: 'password', name: 'confirmPassword', message: '请确认密码:', mask: '*', validate: (v, a) => v === a.password || '两次密码不一致' }
    ]);

    console.log(chalk.yellow('\n正在生成钱包...\n'));
    
    const mnemonic = walletModule.generateMnemonic();
    const wallet = walletModule.mnemonicToWallet(mnemonic);
    const filePath = walletModule.saveWallet(answers.name, wallet, answers.password);

    console.log(chalk.green('✓ 钱包创建成功！\n'));
    console.log(chalk.cyan('⚠️  重要提示：请务必备份好助记词！丢失助记词将无法恢复钱包！\n'));
    console.log(chalk.yellow('助记词（请妥善保管，不要泄露给任何人）:'));
    console.log(chalk.white.bgBlack(`  ${mnemonic}  `));
    console.log('');
    console.log(`钱包名称: ${chalk.cyan(answers.name)}`);
    console.log(`钱包地址: ${chalk.cyan(wallet.address)}`);
    console.log(`保存路径: ${chalk.gray(filePath)}\n`);
  } catch (error) {
    console.error(chalk.red('创建钱包失败:'), error.message);
  }
}

async function importWallet() {
  try {
    const answers = await inquirer.prompt([
      { type: 'input', name: 'name', message: '请输入钱包名称:', default: 'imported-wallet' },
      { type: 'password', name: 'password', message: '请输入钱包密码（至少8位）:', mask: '*', validate: v => v.length >= 8 || '密码至少8位' },
      { type: 'password', name: 'confirmPassword', message: '请确认密码:', mask: '*', validate: (v, a) => v === a.password || '两次密码不一致' },
      {
        type: 'list',
        name: 'importType',
        message: '选择导入方式:',
        choices: [
          { name: '助记词', value: 'mnemonic' },
          { name: '私钥', value: 'privateKey' }
        ]
      }
    ]);

    let wallet;
    if (answers.importType === 'mnemonic') {
      const mnemonicAnswer = await inquirer.prompt([
        { type: 'input', name: 'mnemonic', message: '请输入助记词（12或24个单词，空格分隔）:' }
      ]);
      wallet = walletModule.mnemonicToWallet(mnemonicAnswer.mnemonic.trim());
    } else {
      const keyAnswer = await inquirer.prompt([
        { type: 'input', name: 'privateKey', message: '请输入私钥（0x开头）:' }
      ]);
      wallet = walletModule.privateKeyToWallet(keyAnswer.privateKey.trim());
    }

    console.log(chalk.yellow('\n正在导入钱包...\n'));
    
    const filePath = walletModule.saveWallet(answers.name, wallet, answers.password);

    console.log(chalk.green('✓ 钱包导入成功！\n'));
    console.log(`钱包名称: ${chalk.cyan(answers.name)}`);
    console.log(`钱包地址: ${chalk.cyan(wallet.address)}`);
    console.log(`保存路径: ${chalk.gray(filePath)}\n`);
  } catch (error) {
    console.error(chalk.red('导入钱包失败:'), error.message);
  }
}

async function listWallets() {
  try {
    const wallets = walletModule.listWallets();
    if (wallets.length === 0) {
      console.log(chalk.yellow('\n暂无钱包，先创建一个钱包吧\n'));
      return;
    }
    console.log(chalk.cyan('\n钱包列表:\n'));
    wallets.forEach((w, i) => {
      console.log(`${i + 1}. ${chalk.green(w.name)}`);
      console.log(`   地址: ${chalk.white(w.address)}`);
      console.log(`   创建时间: ${chalk.gray(new Date(w.createdAt).toLocaleString())}\n`);
    });
  } catch (error) {
    console.error(chalk.red('列出钱包失败:'), error.message);
  }
}

async function deleteWallet() {
  try {
    const wallets = walletModule.listWallets();
    if (wallets.length === 0) {
      console.log(chalk.yellow('\n暂无钱包\n'));
      return;
    }
    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'name',
        message: '选择要删除的钱包:',
        choices: wallets.map(w => w.name)
      },
      {
        type: 'confirm',
        name: 'sure',
        message: chalk.red('⚠️  确定要删除钱包吗？此操作不可恢复！'),
        default: false
      }
    ]);

    if (answers.sure) {
      walletModule.deleteWallet(answers.name);
      console.log(chalk.green(`\n✓ 钱包 "${answers.name}" 已删除\n`));
    } else {
      console.log(chalk.yellow('\n已取消\n'));
    }
  } catch (error) {
    console.error(chalk.red('删除钱包失败:'), error.message);
  }
}

function listChains() {
  const chains = chainsModule.getSupportedChains();
  console.log(chalk.cyan('\n支持的区块链网络:\n'));
  chains.forEach(c => {
    console.log(`• ${chalk.green(c.key)} - ${c.name} (ChainId: ${c.chainId}, 代币: ${c.symbol})`);
  });
  console.log('');
}

async function checkBalance() {
  try {
    const wallets = walletModule.listWallets();
    if (wallets.length === 0) {
      console.log(chalk.yellow('\n暂无钱包\n'));
      return;
    }

    const chains = chainsModule.getSupportedChains();
    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'name',
        message: '选择钱包:',
        choices: wallets.map(w => w.name)
      },
      {
        type: 'list',
        name: 'chain',
        message: '选择区块链网络:',
        choices: chains.map(c => ({ name: `${c.name} (${c.symbol})`, value: c.key }))
      },
      { type: 'password', name: 'password', message: '请输入钱包密码:', mask: '*' },
      {
        type: 'confirm',
        name: 'queryToken',
        message: '是否查询ERC20代币余额?',
        default: false
      }
    ]);

    let tokenAddress = null;
    if (answers.queryToken) {
      const tokenAnswer = await inquirer.prompt([
        { type: 'input', name: 'token', message: '请输入代币合约地址:' }
      ]);
      tokenAddress = tokenAnswer.token;
    }

    const walletData = walletModule.loadWallet(answers.name, answers.password);
    const chainInfo = chainsModule.getChain(answers.chain);
    
    console.log(chalk.yellow(`\n正在查询 ${chainInfo.name} 网络余额...\n`));

    const balance = await txModule.getBalance(answers.chain, walletData.address);
    console.log(`钱包: ${chalk.cyan(answers.name)}`);
    console.log(`地址: ${chalk.white(walletData.address)}`);
    console.log(`网络: ${chalk.cyan(chainInfo.name)}`);
    console.log(chalk.green(`\n原生币余额: ${balance.formatted} ${balance.symbol}`));

    if (tokenAddress) {
      try {
        const tokenBalance = await txModule.getTokenBalance(answers.chain, tokenAddress, walletData.address);
        console.log(chalk.green(`代币余额: ${tokenBalance.formatted} ${tokenBalance.symbol}`));
      } catch (e) {
        console.log(chalk.red('代币查询失败，请检查合约地址'));
      }
    }

    const explorerUrl = txModule.getAddressUrl(answers.chain, walletData.address);
    console.log(`\n区块链浏览器: ${chalk.blue.underline(explorerUrl)}\n`);
  } catch (error) {
    console.error(chalk.red('查询余额失败:'), error.message);
  }
}

async function transfer() {
  try {
    const wallets = walletModule.listWallets();
    if (wallets.length === 0) {
      console.log(chalk.yellow('\n暂无钱包\n'));
      return;
    }

    const chains = chainsModule.getSupportedChains();
    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'name',
        message: '选择钱包:',
        choices: wallets.map(w => w.name)
      },
      {
        type: 'list',
        name: 'chain',
        message: '选择区块链网络:',
        choices: chains.map(c => ({ name: `${c.name} (${c.symbol})`, value: c.key }))
      },
      { type: 'password', name: 'password', message: '请输入钱包密码:', mask: '*' },
      {
        type: 'confirm',
        name: 'isToken',
        message: '是否转账ERC20代币?',
        default: false
      }
    ]);

    let tokenAddress = null;
    if (answers.isToken) {
      const tokenAnswer = await inquirer.prompt([
        { type: 'input', name: 'token', message: '请输入代币合约地址:' }
      ]);
      tokenAddress = tokenAnswer.token;
    }

    const walletData = walletModule.loadWallet(answers.name, answers.password);
    const chainInfo = chainsModule.getChain(answers.chain);
    
    console.log(chalk.yellow(`\n当前网络: ${chainInfo.name}\n`));
    
    const balance = await txModule.getBalance(answers.chain, walletData.address);
    console.log(`当前余额: ${chalk.green(balance.formatted)} ${balance.symbol}\n`);

    if (tokenAddress) {
      try {
        const tokenBalance = await txModule.getTokenBalance(answers.chain, tokenAddress, walletData.address);
        console.log(`代币余额: ${chalk.green(tokenBalance.formatted)} ${tokenBalance.symbol}\n`);
      } catch (e) {
        console.log(chalk.red('代币信息查询失败，请检查合约地址\n'));
        return;
      }
    }

    const transferAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'to',
        message: '接收地址:',
        validate: v => walletModule.isValidAddress(v) || '请输入有效的地址'
      },
      {
        type: 'input',
        name: 'amount',
        message: '转账数量:',
        validate: v => !isNaN(parseFloat(v)) && parseFloat(v) > 0 || '请输入有效的数量'
      },
      {
        type: 'confirm',
        name: 'confirm',
        message: chalk.yellow('确认转账? 此操作不可撤销!'),
        default: false
      }
    ]);

    if (!transferAnswers.confirm) {
      console.log(chalk.yellow('\n已取消转账\n'));
      return;
    }

    console.log(chalk.yellow('\n正在发送交易...\n'));

    let tx;
    if (tokenAddress) {
      tx = await txModule.sendToken(answers.chain, walletData.wallet, tokenAddress, transferAnswers.to, transferAnswers.amount);
    } else {
      tx = await txModule.sendNativeToken(answers.chain, walletData.wallet, transferAnswers.to, transferAnswers.amount);
    }

    console.log(chalk.green('✓ 交易已发送!\n'));
    console.log(`交易哈希: ${chalk.cyan(tx.hash)}`);
    console.log(`区块链浏览器: ${chalk.blue.underline(txModule.getExplorerUrl(answers.chain, tx.hash))}`);
    console.log(chalk.yellow('\n等待交易确认（最多等待60秒）...\n'));

    try {
      const receipt = await Promise.race([
        txModule.waitForTransaction(answers.chain, tx.hash, 1),
        new Promise((_, reject) => setTimeout(() => reject(new Error('超时')), 60000))
      ]);
      
      if (receipt.status === 1) {
        console.log(chalk.green('✓ 交易已确认!\n'));
        console.log(`区块高度: ${receipt.blockNumber}`);
        console.log(`Gas使用: ${receipt.gasUsed.toString()}\n`);
      } else {
        console.log(chalk.red('✗ 交易失败\n'));
      }
    } catch (e) {
      console.log(chalk.yellow('交易已广播，但等待确认超时，请在区块链浏览器查看状态\n'));
    }
  } catch (error) {
    console.error(chalk.red('转账失败:'), error.message);
  }
}

async function startInteractive() {
  console.log(chalk.cyan(`
╔═══════════════════════════════════════╗
║     多链加密货币钱包 CLI v1.0.0       ║
║     Multi-chain Crypto Wallet         ║
╚═══════════════════════════════════════╝
  `));

  while (true) {
    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: '请选择操作:',
        choices: [
          { name: '📝 创建新钱包', value: 'create' },
          { name: '📥 导入钱包', value: 'import' },
          { name: '📋 钱包列表', value: 'list' },
          { name: '💰 查询余额', value: 'balance' },
          { name: '💸 转账', value: 'transfer' },
          { name: '🌐 支持的链', value: 'chains' },
          { name: '🗑️  删除钱包', value: 'delete' },
          { name: '🚪 退出', value: 'exit' }
        ]
      }
    ]);

    switch (answers.action) {
      case 'create':
        await createWallet();
        break;
      case 'import':
        await importWallet();
        break;
      case 'list':
        await listWallets();
        break;
      case 'balance':
        await checkBalance();
        break;
      case 'transfer':
        await transfer();
        break;
      case 'chains':
        listChains();
        break;
      case 'delete':
        await deleteWallet();
        break;
      case 'exit':
        console.log(chalk.cyan('\n再见! 👋\n'));
        process.exit(0);
    }
  }
}

module.exports = {
  startInteractive,
  createWallet,
  importWallet,
  listWallets,
  deleteWallet,
  listChains,
  checkBalance,
  transfer
};
