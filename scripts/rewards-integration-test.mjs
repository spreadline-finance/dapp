import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, createTestClient, defineChain, http, encodeFunctionData, parseEventLogs, zeroAddress } from 'viem';
import { build } from 'esbuild';
await promisify(execFile)('forge', ['build', '--root', 'contracts']);
await build({entryPoints:['src/lib/reward-merkle.ts'],bundle:true,platform:'node',format:'esm',outfile:'.wrangler/tests/merkle-integration.mjs'});
await build({entryPoints:['src/lib/fee-distributor-contract.ts'],bundle:true,platform:'node',format:'esm',outfile:'.wrangler/tests/abi-integration.mjs'});
await build({entryPoints:['scripts/rewards-indexer.ts'],bundle:true,platform:'node',format:'esm',outfile:'.wrangler/tests/indexer-integration.mjs'});
const { buildRewardManifest } = await import('../.wrangler/tests/merkle-integration.mjs');
const { feeDistributorAbi, feeDistributionLeaf } = await import('../.wrangler/tests/abi-integration.mjs');
const { indexHolders } = await import('../.wrangler/tests/indexer-integration.mjs');
const port = Number(process.env.REWARDS_TEST_PORT || '18547');
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Use a valid dedicated localhost test port.');
const node = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '4663', '--silent'], {stdio: ['ignore', 'ignore', 'pipe']});
let childError;
node.once('error', error => { childError = error; });
node.stderr.on('data', data => { childError = new Error(data.toString().trim()); });
const url=`http://127.0.0.1:${port}`;
try {
const chain=defineChain({id:4663,name:'Local-only reward integration',nativeCurrency:{name:'Test Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[url]}}});
const transport=http(url,{retryCount:0});
const client=createPublicClient({chain,transport,pollingInterval:100});
const wallet=createWalletClient({chain,transport});
const local=createTestClient({chain,transport,mode:'anvil'});
await pause(300);
for (let attempt = 0; attempt < 40; attempt++) {
  if (childError || node.exitCode !== null) throw childError || new Error('The local test node stopped.');
  try { assert.equal(await client.getChainId(), 4663); break; }
  catch (error) { if (attempt === 39) throw error; await pause(100); }
}
if (childError || node.exitCode !== null) throw childError || new Error('The local test node stopped.');
const [owner,alice,bob,charlie,dev,treasury]=await wallet.getAddresses();
const artifact=async(name,test=true)=>JSON.parse(await readFile(`contracts/out/${test?'SpreadlineFeeDistributor.t.sol':'SpreadlineFeeDistributor.sol'}/${name}.json`,'utf8'));
const deploy=async(name,args=[],test=true)=>{const a=await artifact(name,test);const hash=await wallet.deployContract({account:owner,abi:a.abi,bytecode:a.bytecode.object,args});const r=await client.waitForTransactionReceipt({hash});assert.equal(r.status,'success');return{address:r.contractAddress,abi:a.abi,block:r.blockNumber};};
const write=async(c,fn,args=[])=>{const hash=await wallet.writeContract({account:owner,address:c.address,abi:c.abi,functionName:fn,args});const r=await client.waitForTransactionReceipt({hash});assert.equal(r.status,'success');return r;};
const read=(c,fn,args=[])=>client.readContract({address:c.address,abi:c.abi,functionName:fn,args});
const escrow=await deploy('FeeTestEscrow');
const holder=await deploy('FeeTestToken');
const factory=await deploy('FeeTestFactory',[escrow.address]);
const hook=await deploy('FeeTestHook',[factory.address,await read(factory,'poolManager')]);
await write(factory,'setHook',[hook.address]);
const policy={holderBps:7500,devBps:1000,treasuryBps:1500,intervalSeconds:900n,rootDelaySeconds:900n,minimumIncome:1n,devWallet:dev,treasuryWallet:treasury};
const distributor=await deploy('SpreadlineFeeDistributor',[zeroAddress,zeroAddress,escrow.address,factory.address,hook.address,owner,owner,policy],false);
const rejected=await deploy('FeeTestRecipient');
await write(rejected,'configure',[true,false]);
const curve=await deploy('FeeTestCurve',[holder.address,zeroAddress,distributor.address,escrow.address]);
await write(factory,'setLaunch',[holder.address,curve.address,distributor.address,zeroAddress,0,true]);
await write(distributor,'bindHolderToken',[holder.address]);
await write(distributor,'setPaused',[false]);
await local.setBalance({address:escrow.address,value:2n*10n**18n});
await write(distributor,'sweepCurveFees');
await write(distributor,'collectPonsFees');
assert.equal(await read(distributor,'totalPonsCollected'),10n**18n);
for(const[account,weight]of[[alice,30n],[bob,70n],[charlie,17n],[rejected.address,13n]])await write(holder,'mint',[account,weight]);
const snapshot=await client.getBlock();
const directory=await mkdtemp(join(tmpdir(),'spreadline-anvil-holder-'));
try{
const indexed=await indexHolders(client,{chainId:4663,token:holder.address,deploymentBlock:holder.block,snapshotBlock:snapshot.number,checkpointPath:join(directory,'holders.json')});
assert.equal(indexed.totalSupply,130n);
const bundle=buildRewardManifest({chainId:4663,distributor:distributor.address,holderToken:holder.address,epochId:'1',snapshotBlock:String(snapshot.number),snapshotBlockHash:snapshot.hash,grossIncome:String(10n**18n),holderBudget:String(75n*10n**16n),policyVersion:'1',exclusions:[{address:zeroAddress,reason:'Burn address'}]},indexed.balances);
for(const entry of bundle.pages[0].entries)assert.equal(await read(distributor,'leafHash',[1n,entry.account,BigInt(entry.weight)]),feeDistributionLeaf(4663n,distributor.address,1n,entry.account,BigInt(entry.weight)));
await write(distributor,'proposeEpoch',[bundle.manifest.root,snapshot.number,snapshot.hash,bundle.manifestHash,130n,10n**18n]);
const epoch=await read(distributor,'epochs',[1n]);
await local.setNextBlockTimestamp({timestamp:epoch.readyAt});await local.mine({blocks:1});
await write(distributor,'activateEpoch',[1n]);
const claims=bundle.pages[0].entries.map(e=>({epochId:1n,account:e.account,weight:BigInt(e.weight),proof:e.proof}));
const before=await Promise.all(claims.map(c=>client.getBalance({address:c.account})));
const data=encodeFunctionData({abi:feeDistributorAbi,functionName:'distributeClaims',args:[claims]});
const estimated=await client.estimateGas({account:owner,to:distributor.address,data});
const gas=estimated*120n/100n;
const hash=await wallet.sendTransaction({account:owner,to:distributor.address,data,gas});
const receipt=await client.waitForTransactionReceipt({hash});
assert.equal(receipt.status,'success');
const paidLogs=parseEventLogs({abi:feeDistributorAbi,eventName:'HolderPaid',logs:receipt.logs});
assert.equal(paidLogs.length,3,'An estimated-gas batch must actually pay all three holders');
let total=0n;
for(let i=0;i<claims.length;i++){const expected=epoch.holderBudget*claims[i].weight/130n;const after=await client.getBalance({address:claims[i].account});const failed=claims[i].account.toLowerCase()===rejected.address.toLowerCase();assert.equal(after-before[i],failed?0n:expected);assert.equal(await read(distributor,'hasClaimed',[1n,claims[i].account]),!failed);if(!failed)total+=expected;}
const rejectedClaim=claims.find(c=>c.account.toLowerCase()===rejected.address.toLowerCase());
assert.equal(parseEventLogs({abi:feeDistributorAbi,eventName:'ClaimSkipped',logs:receipt.logs}).length,1);
const aliceBeforeRedirect=await client.getBalance({address:alice});
await write(rejected,'claimTo',[distributor.address,1n,rejectedClaim.weight,rejectedClaim.proof,alice]);
const redirected=epoch.holderBudget*rejectedClaim.weight/130n;
assert.equal(await client.getBalance({address:alice})-aliceBeforeRedirect,redirected);
assert.equal(await read(distributor,'hasClaimed',[1n,rejected.address]),true);
total+=redirected;
await write(distributor,'withdrawCashFor',[dev]);await write(distributor,'withdrawCashFor',[treasury]);
const reserve=await read(distributor,'totalReserved');
assert.equal(await read(distributor,'totalHolderPaid'),total);
assert.equal(await read(distributor,'totalDevPaid'),10n**17n);
assert.equal(await read(distributor,'totalTreasuryPaid'),15n*10n**16n);
assert.equal(await read(distributor,'availableIncome'),0n);
assert.equal(await client.getBalance({address:distributor.address}),reserve);
assert.equal(total+10n**17n+15n*10n**16n+reserve,10n**18n);
console.log(JSON.stringify({network:'LOCAL ANVIL ONLY',holders:4,typescriptLeavesMatchedSolidity:true,indexedSupply:'130',failedRecipientRetainedAndRedirected:true,realLocalBatchGasUsed:String(receipt.gasUsed),estimatedGas:String(estimated),gasLimit:String(gas),holderPaid:String(total),devPaid:String(10n**17n),treasuryPaid:String(15n*10n**16n),reservedRoundingDust:String(reserve),cashReconciled:true},null,2));
}finally{await rm(directory,{recursive:true,force:true});}

} finally { node.kill('SIGTERM'); }
