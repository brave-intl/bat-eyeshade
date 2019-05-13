'use strict'

import { serial as test } from 'ava'
import uuidV4 from 'uuid/v4'
import extrasUtils from 'bat-utils/lib/extras-utils'
import Postgres from 'bat-utils/lib/runtime-postgres'
import Currency from 'bat-utils/lib/runtime-currency'
import transaction from '../../eyeshade/lib/transaction'
import _ from 'underscore'

import {
  cleanDbs
} from '../utils'
const {
  createdTimestamp
} = extrasUtils
const {
  knownChains,
  insertTransaction,
  insertUserDepositFromChain,
  insertFromSettlement,
  insertFromReferrals,
  insertFromVoting,
  updateBalances
} = transaction

const postgres = new Postgres({ postgres: { url: process.env.BAT_POSTGRES_URL } })

const runtime = {
  config: {
    wallet: {
      settlementAddress: {
        'BAT': '0xdeadbeef'
      }
    }
  },
  currency: new Currency({
    currency: {
      url: process.env.BAT_RATIOS_URL,
      access_token: process.env.BAT_RATIOS_TOKEN
    }
  }, {}),
  postgres
}

test.afterEach.always(async () => { await cleanDbs() })

const toString = () => '5b5e55000000000000000000' // 2018-07-30T00:00:00.000Z
const docId = {
  toHexString: toString,
  toString
}
const settlementId = uuidV4().toLowerCase()
const ownerId = 'publishers#uuid:' + uuidV4().toLowerCase()

const contributionSettlement = {
  probi: '9500000000000000000',
  fees: '500000000000000000',
  altcurrency: 'BAT',
  _id: docId,
  type: 'contribution',
  publisher: 'foo.com',
  owner: ownerId,
  settlementId: settlementId,
  address: uuidV4().toLowerCase(),
  amount: '9.5',
  currency: 'BAT'
}

const referralSettlement = {
  probi: '10000000000000000000',
  fees: '0',
  altcurrency: 'BAT',
  _id: docId,
  type: 'referral',
  publisher: 'foo.com',
  owner: ownerId,
  settlementId: settlementId,
  address: uuidV4().toLowerCase(),
  amount: '10',
  currency: 'BAT'
}

test('contribution settlement transaction', async t => {
  t.plan(12)

  const client = await runtime.postgres.connect()
  try {
    await client.query('BEGIN')
    await insertFromSettlement(runtime, client, contributionSettlement)
    await client.query('COMMIT')

    const txns = await client.query('select * from transactions order by created_at;')

    t.true(txns.rows.length === 3)
    // first the contribution enters the owner account
    t.true(txns.rows[0].transaction_type === 'contribution')
    // next fees are removed
    t.true(txns.rows[1].transaction_type === 'fees')
    // finally payout to uphold occurs
    t.true(txns.rows[2].transaction_type === 'contribution_settlement')

    await updateBalances(runtime, client)

    const upholdBalance = await client.query(`select * from account_balances where account_type = 'uphold';`)
    t.true(upholdBalance.rows.length === 1)
    t.true(Number(upholdBalance.rows[0].balance) === 9.5)

    const ownerBalance = await client.query(`select * from account_balances where account_type = 'owner';`)
    t.true(ownerBalance.rows.length === 1)
    t.true(Number(ownerBalance.rows[0].balance) === 0.0)

    const channelBalance = await client.query(`select * from account_balances where account_type = 'channel';`)
    t.true(channelBalance.rows.length === 1)
    t.true(Number(channelBalance.rows[0].balance) === -10.0)

    const feesBalance = await client.query(`select * from account_balances where account_type = 'internal';`)
    t.true(feesBalance.rows.length === 1)
    t.true(Number(feesBalance.rows[0].balance) === 0.5)
  } finally {
    client.release()
  }
})

test('referral settlement transaction', async t => {
  t.plan(6)

  const client = await runtime.postgres.connect()
  try {
    await client.query('BEGIN')
    await insertFromSettlement(runtime, client, referralSettlement)
    await client.query('COMMIT')

    const txns = await client.query('select * from transactions order by created_at;')

    t.true(txns.rows.length === 1)
    // payout to uphold occurs
    t.true(txns.rows[0].transaction_type === 'referral_settlement')

    await updateBalances(runtime, client)

    const upholdBalance = await client.query(`select * from account_balances where account_type = 'uphold';`)
    t.true(upholdBalance.rows.length === 1)
    t.true(Number(upholdBalance.rows[0].balance) === 10.0)

    const ownerBalance = await client.query(`select * from account_balances where account_type = 'owner';`)
    t.true(ownerBalance.rows.length === 1)
    t.true(Number(ownerBalance.rows[0].balance) === -10.0)
  } finally {
    client.release()
  }
})

test('settlement transaction throws on invalid altcurrency', async t => {
  t.plan(1)
  const client = await runtime.postgres.connect()
  try {
    const settlement = _.clone(contributionSettlement)
    settlement.altcurrency = 'ETH'
    await t.throwsAsync(insertFromSettlement(runtime, client, settlement))
  } finally {
    client.release()
  }
})

test('settlement transaction throws on missing probi', async t => {
  t.plan(1)
  const client = await runtime.postgres.connect()
  try {
    const settlement = _.clone(contributionSettlement)
    delete settlement.probi
    await t.throwsAsync(insertFromSettlement(runtime, client, settlement))
  } finally {
    client.release()
  }
})

test('settlement transaction throws on 0 probi', async t => {
  t.plan(1)
  const client = await runtime.postgres.connect()
  try {
    const settlement = _.clone(contributionSettlement)
    settlement.probi = '0'
    await t.throwsAsync(insertFromSettlement(runtime, client, settlement))
  } finally {
    client.release()
  }
})

test('settlement transaction throws on negative probi', async t => {
  t.plan(1)
  const client = await runtime.postgres.connect()
  try {
    const settlement = _.clone(contributionSettlement)
    settlement.probi = '-1'
    await t.throwsAsync(insertFromSettlement(runtime, client, settlement))
  } finally {
    client.release()
  }
})

test('settlement transaction throws on missing owner', async t => {
  t.plan(1)
  const client = await runtime.postgres.connect()
  try {
    const settlement = _.clone(contributionSettlement)
    delete settlement.owner
    await t.throwsAsync(insertFromSettlement(runtime, client, settlement))
  } finally {
    client.release()
  }
})

const voting = {
  amount: '9.5',
  fees: '0.5',
  surveyorId: uuidV4().toLowerCase(),
  channel: 'foo.com'
}

test('voting transaction', async t => {
  t.plan(6)

  const client = await runtime.postgres.connect()
  try {
    await client.query('BEGIN')
    await insertFromVoting(runtime, client, voting, new Date(createdTimestamp(docId)).toISOString())
    await client.query('COMMIT')

    const txns = await client.query('select * from transactions order by created_at;')

    t.true(txns.rows.length === 1)
  // payout to uphold occurs
    t.true(txns.rows[0].transaction_type === 'contribution')

    await updateBalances(runtime, client)

    const settlementBalance = await client.query(`select * from account_balances where account_type = 'uphold';`)
    t.true(settlementBalance.rows.length === 1)
    t.true(Number(settlementBalance.rows[0].balance) === -10.0)

    const channelBalance = await client.query(`select * from account_balances where account_type = 'channel';`)
    t.true(channelBalance.rows.length === 1)
    t.true(Number(channelBalance.rows[0].balance) === 10.0)
  } finally {
    client.release()
  }
})

test('voting and contribution settlement transaction', async t => {
  t.plan(5)

  const client = await runtime.postgres.connect()
  try {
    await client.query('BEGIN')
    await insertFromVoting(runtime, client, voting, new Date(createdTimestamp(docId)).toISOString())
    await insertFromSettlement(runtime, client, contributionSettlement)
    await client.query('COMMIT')

    const txns = await client.query('select * from transactions order by created_at;')
    t.true(txns.rows.length === 4)

    await updateBalances(runtime, client)

    const channelBalance = await client.query(`select * from account_balances where account_type = 'channel';`)
    t.true(channelBalance.rows.length === 1)
    t.true(Number(channelBalance.rows[0].balance) === 0.0)

    const ownerBalance = await client.query(`select * from account_balances where account_type = 'owner';`)
    t.true(ownerBalance.rows.length === 1)
    t.true(Number(ownerBalance.rows[0].balance) === 0.0)
  } finally {
    client.release()
  }
})

const referrals = {
  probi: '10000000000000000000',
  firstId: docId,
  transactionId: uuidV4().toLowerCase(),
  _id: {
    altcurrency: 'BAT',
    owner: ownerId,
    publisher: 'foo.com'
  }
}

test('referral transaction', async t => {
  t.plan(4)

  const client = await runtime.postgres.connect()
  try {
    await client.query('BEGIN')
    await insertFromReferrals(runtime, client, referrals)
    await client.query('COMMIT')

    const txns = await client.query('select * from transactions order by created_at;')

    t.true(txns.rows.length === 1)
    // payout to uphold occurs
    t.true(txns.rows[0].transaction_type === 'referral')

    await updateBalances(runtime, client)

    const ownerBalance = await client.query(`select * from account_balances where account_type = 'owner';`)
    t.true(ownerBalance.rows.length === 1)
    t.true(Number(ownerBalance.rows[0].balance) === 10.0)
  } finally {
    client.release()
  }
})

test('referral and referral settlement transaction', async t => {
  t.plan(3)

  const client = await runtime.postgres.connect()
  try {
    await client.query('BEGIN')
    await insertFromReferrals(runtime, client, referrals)
    await insertFromSettlement(runtime, client, referralSettlement)
    await client.query('COMMIT')

    const txns = await client.query('select * from transactions order by created_at;')
    t.true(txns.rows.length === 2)

    await updateBalances(runtime, client)

    const ownerBalance = await client.query(`select * from account_balances where account_type = 'owner';`)
    t.true(ownerBalance.rows.length === 1)
    t.true(Number(ownerBalance.rows[0].balance) === 0.0)
  } finally {
    client.release()
  }
})

test('can add transactions for different account types', async (t) => {
  t.plan(6)

  const client = await runtime.postgres.connect()
  await t.throwsAsync(insertUserDepositFromChain(runtime, client), Error, 'amount is required')
  await t.throwsAsync(insertUserDepositFromChain(runtime, client, {
    amount: {}
  }), Error, 'amount goes through bignumber')
  const fakeAddress = '0xbloop'
  const noValueTransferred = await insertUserDepositFromChain(runtime, client, {
    amount: '0'
  })
  t.deepEqual([], noValueTransferred, 'when no value is transferred, we skip inserting the tx')
  for (let ticker in knownChains) {
    const chain = knownChains[ticker]
    const createdAt = new Date()
    const id = uuidV4().toLowerCase()
    const cardId = uuidV4()
    const type = (Math.random() < (1 / 3)) ? 'transfer' : (Math.random() < 0.5 ? 'deposit' : 'withdrawal')
    const inputs = {
      // should be the transaction id from the chain
      id,
      type,
      amount: 1,
      chain,
      cardId,
      createdAt,
      address: fakeAddress
    }
    const txs = await insertUserDepositFromChain(runtime, client, inputs)
    const expectedResults = [{
      created_at: createdAt,
      description: `deposits from ${chain} chain`,
      transaction_type: `user_deposit`,
      document_id: id,
      from_account: fakeAddress,
      from_account_type: chain,
      to_account: cardId,
      to_account_type: 'uphold',
      amount: '1.000000000000000000',
      settlement_amount: null,
      channel: null,
      settlement_currency: null
    }]
    const subResults = txs.map((row) => _.omit(row, ['id']))
    t.deepEqual(expectedResults, subResults, `chain ${chain} is a valid from_account type`)
  }
  await client.release()
})

test('common insertion fn', async (t) => {
  t.plan(2)
  const id = uuidV4()
  const createdAt = new Date()
  const description = 'a known description'
  const transactionType = 'contribution'
  const documentId = uuidV4()
  const fromAccount = uuidV4()
  const fromAccountType = 'uphold'
  const toAccount = uuidV4()
  const toAccountType = 'uphold'
  const amount = '1.000000000000000000'
  const inputs = {
    id,
    createdAt: +createdAt / 1000,
    description,
    transactionType,
    documentId,
    fromAccount,
    fromAccountType,
    toAccount,
    toAccountType,
    amount
  }
  const client = await runtime.postgres.connect()
  const txs = await insertTransaction(client, inputs)
  const zeroAmount = Object.assign({}, inputs, { amount: '0' })
  await insertTransaction(client, zeroAmount)
  const negativeAmount = Object.assign({}, inputs, { amount: '-1' })
  await insertTransaction(client, negativeAmount)
  const noAmount = Object.assign({}, inputs, { amount: null })
  await t.throwsAsync(() => insertTransaction(client, noAmount))
  const expectedResults = [{
    id,
    amount,
    created_at: createdAt,
    description,
    transaction_type: transactionType,
    document_id: documentId,
    from_account: fromAccount,
    from_account_type: fromAccountType,
    to_account: toAccount,
    to_account_type: toAccountType,
    channel: null,
    settlement_amount: null,
    settlement_currency: null
  }]
  t.deepEqual(expectedResults, txs, `transactions are inserted`)
  await client.release()
})
