import { createLogger } from 'bunyan'
import pQueue from 'p-queue'
import { ApiPromise, WsProvider } from '@polkadot/api'
import Demical from 'decimal.js'
import types from './typedefs.json'
import BN from 'bn.js'
import Koa from 'koa'

const { default: Queue } = pQueue

const ONE_THOUSAND = new BN('1000', 10)
const ZERO = new BN('0')
const LAST_BLOCK = 1304000
const LAST_ROUND = 2181
const DEFAULT_OUTPUT = 'null'
const WS_ENDPOINT = process.env.WS_ENDPOINT || 'wss://hashbox-lan.corp.phala.network/ws1'
const HTTP_PORT = process.env.HTTP_PORT ? parseInt(process.env.HTTP_PORT) : 3000

const queue = new Queue({
  timeout: 30000,
  throwOnTimeout: true,
  concurrency: 1
})

globalThis.$logger = createLogger({
  level: 'info',
  name: 'dashboard'
})

let jsonOutput = DEFAULT_OUTPUT
let lastBlockHeader

const main = async () => {
  const provider = new WsProvider(WS_ENDPOINT)
  const api = await ApiPromise.create({ provider, types })
  globalThis.api = api

  let roundStartAt = 0
  let currentRound = 0

  const [phalaChain, phalaNodeName, phalaNodeVersion] = (await Promise.all([
    api.rpc.system.chain(),
    api.rpc.system.name(),
    api.rpc.system.version()
  ])).map(i => i.toString())
  $logger.info({ chain: phalaChain }, `Connected to chain ${phalaChain} using ${phalaNodeName} v${phalaNodeVersion}`)

  return api.rpc.chain.subscribeNewHeads(async header => {
    const number = header.number.toNumber()

    if (number > LAST_BLOCK) {
      if (jsonOutput !== DEFAULT_OUTPUT) { return }
      if (!lastBlockHeader) {
        const lastBlockHeaderHash = await api.rpc.chain.getBlockHash(LAST_BLOCK)
        lastBlockHeader = await api.rpc.chain.getHeader(lastBlockHeaderHash)
      }
      return queue.add(() => processRoundAt(lastBlockHeader, LAST_ROUND, api).catch(console.error))
    }

    if (number === roundStartAt) {
      return queue.add(() => processRoundAt(header, currentRound, api).catch(console.error))
    }

    const events = await api.query.system.events.at(header.hash)

    let hasEvent = false

    events.forEach(record => {
      const { event } = record

      if (event.section === 'phalaModule' && event.method === 'NewMiningRound') {
        hasEvent = true
        currentRound = event.data[0].toNumber()
        $logger.info(`Starting round #${currentRound} at block #${number + 1}...`)
      }
    })

    if (hasEvent) {
      roundStartAt = number + 1
    } else {
      if (!(roundStartAt && currentRound)) {
        roundStartAt = number + 1
        const roundInfo = await api.query.phalaModule.round.at(header.hash)
        currentRound = roundInfo.round.toNumber()
        $logger.info(`Starting round #${currentRound} at block #${roundInfo.startBlock.toNumber()}...`)
      }
    }
  })
}

const processRoundAt = async (header, roundNumber, api) => {
  const blockHash = header.hash

  const accumulatedFire2 = (await api.query.phalaModule.accumulatedFire2.at(blockHash)) || new BN('0')
  const accumulatedFire2Demical = new Demical(accumulatedFire2.toString())
  const onlineWorkers = await api.query.phalaModule.onlineWorkers.at(blockHash)
  const totalPower = await api.query.phalaModule.totalPower.at(blockHash)

  const stashAccounts = {}
  const stashKeys = await api.query.phalaModule.stashState.keysAt(blockHash)
  const stashCount = stashKeys.length
  await Promise.all(
    (stashKeys)
      .map(async k => {
        const stash = k.args[0].toString()
        const value = (await api.rpc.state.getStorage(k, blockHash)).toJSON()
        stashAccounts[stash] = {
          controller: value.controller,
          payout: value.payoutPrefs.target
        }
      }))

  const payoutAccounts = {}
  await Promise.all(
    (await api.query.phalaModule.fire2.keysAt(blockHash))
      .map(async k => {
        const account = k.args[0].toString()
        const value = await api.rpc.state.getStorage(k, blockHash)
        const fire2 = value.toString()
        payoutAccounts[account] = {
          ...payoutAccounts[account],
          fire2,
          fire2Human: value.toHuman().replace(/PHA$/, '').replace(' ', ''),
          prizeRatio: new Demical(fire2).div(accumulatedFire2Demical).toNumber(),
          workerCount: 0,
          payoutComputeReward: 0
        }
      }))

  await Promise.all(
    (await api.query.phalaModule.payoutComputeReward.keysAt(blockHash))
      .map(async k => {
        const account = k.args[0].toString()
        const value = await api.rpc.state.getStorage(k, blockHash)
        const payoutComputeReward = value.toNumber() || 0

        if (!payoutAccounts[account]) { return }
        payoutAccounts[account] = {
          ...payoutAccounts[account],
          payoutComputeReward
        }
      })
  )

  const validStashAccounts = {}
  let accumulatedScore = 0
  await Promise.all(
    (await api.query.phalaModule.workerState.keysAt(blockHash))
      .map(async k => {
        const stash = k.args[0].toString()
        const payout = stashAccounts[stash].payout
        const value = (await api.rpc.state.getStorage(k, blockHash)).toJSON()

        if (typeof value.state.Mining === 'undefined') { return }
        accumulatedScore += value.score.overallScore

        validStashAccounts[stash] = stashAccounts[stash]

        if (payoutAccounts[payout]) {
          payoutAccounts[payout] = {
            ...payoutAccounts[payout],
            workerCount: payoutAccounts[payout].workerCount + 1
          }
        }
      }))

  let accumulatedStake = undefined
  await Promise.all(
    (await api.query.miningStaking.stakeReceived.keysAt(blockHash))
      .map(async k => {
        const stash = k.args[0].toString()
        const stashAccount = validStashAccounts[stash]

        if (!stashAccount) { return }

        // const value = (await api.rpc.state.getStorage(k, blockHash)).div(ONE_THOUSAND)
        const value = (await api.rpc.state.getStorage(k, blockHash))
        accumulatedStake = typeof accumulatedStake === 'undefined'
          ? value : accumulatedStake.add(value)

        const payout = stashAccount.payout
        const payoutAccount = payoutAccounts[payout]

        if (!payoutAccount) { return }
        if (!value) { return }

        payoutAccount.stake = value.add(payoutAccount.stake || ZERO)
      })
  )

  accumulatedStake = accumulatedStake || new BN('0')
  const accumulatedStakeDemical = new Demical(accumulatedStake.toString())
  Object.entries(payoutAccounts).forEach(([k, v]) => {
    const value = payoutAccounts[k].stake || new BN('0')
    const valueDemical = new Demical(value.toString())

    payoutAccounts[k].stake = value.toString()
    payoutAccounts[k].stakeHuman = api.createType('BalanceOf', payoutAccounts[k].stake).toHuman().replace(/PHA$/, '').replace(' ', '').trim()
    payoutAccounts[k].stakeRatio = valueDemical.div(accumulatedStakeDemical).toNumber()
  })

  const avgStakeDemical = accumulatedStakeDemical.div(stashCount)
  const avgStake = avgStakeDemical
    .div(1000)
    .div(1000)
    .div(1000)
    .div(1000)

  const output = {
    roundNumber,
    updatedAt: Date.now(),
    accumulatedFire2: accumulatedFire2.toString(),
    onlineWorkers: onlineWorkers.toString(),
    totalPower: totalPower.toString(),
    accumulatedStake: accumulatedStake.toString(),
    accumulatedStakeHuman: api.createType('BalanceOf', accumulatedStake).toHuman().replace(/PHA$/, '').replace(' ', '').trim(),
    stashAccounts: validStashAccounts,
    payoutAccounts,
    stashCount,
    avgStakeDemical,
    avgStake: parseFloat(avgStake),
    avgScore: accumulatedScore / onlineWorkers.toNumber()
  }
  jsonOutput = JSON.stringify(output)
  $logger.info(`Updated output from round #${roundNumber}.`)
}

main().catch((error) => {
  console.error(error);
  process.exit(-1);
})

const app = new Koa()

app.use(async ctx => {
  ctx.set('Content-Type', 'application/json');
  ctx.body = jsonOutput
})

app.on('error', (err, ctx) => {
  $logger.error(err, ctx)
})

$logger.info(`Listening on port ${HTTP_PORT}...`)
app.listen(HTTP_PORT)
