'use strict'

import {
  serial as test
} from 'ava'
import uuidV4 from 'uuid/v4'
import _ from 'underscore'
import {
  insertTransaction,
  insertFromSettlement,
  insertFromReferrals
} from '../../eyeshade/lib/transaction'

import { Runtime } from 'bat-utils'
import {
  eyeshadeAgent,
  cleanPgDb,
  ok
} from '../utils'
import {
  agent
} from 'supertest'

const docId = {
  toString: () => '5b5e55000000000000000000' // 2018-07-30T00:00:00.000Z
}
docId.toHexString = docId.toString
const settlementId = uuidV4().toLowerCase()
const ownerId = 'publishers#uuid:' + uuidV4().toLowerCase()
const toOwnerId = 'publishers#uuid:' + uuidV4().toLowerCase()
const runtime = new Runtime({
  postgres: { url: process.env.BAT_POSTGRES_URL },
  currency: {
    url: process.env.BAT_RATIOS_URL,
    access_token: process.env.BAT_RATIOS_TOKEN
  },
  wallet: {
    settlementAddress: { 'BAT': '0xdeadbeef' },
    adsPayoutAddress: { 'BAT': '0xdeadbeef' }
  }
})

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

const referralsBar = {
  probi: '12000000000000000000',
  firstId: docId,
  transactionId: uuidV4().toLowerCase(),
  _id: {
    altcurrency: 'BAT',
    owner: ownerId,
    publisher: 'bar.com'
  }
}

test.afterEach(cleanPgDb(runtime.postgres))

const auth = (agent) => agent.set('Authorization', 'Bearer foobarfoobar')

test('check auth scope', async (t) => {
  t.plan(0)
  const AUTH = 'Authorization'
  const KEY = `Bearer fake`
  const unauthed = agent(process.env.BAT_EYESHADE_SERVER)
  await unauthed.get('/v1/accounts/settlements/referrals/total').expect(401)
  await unauthed.get('/v1/accounts/earnings/referral/total').expect(401)
  await unauthed.get('/v1/accounts/owner/transactions').expect(401)
  await unauthed.get('/v1/accounts/settlements/referrals/total').set(AUTH, KEY).expect(401)
  await unauthed.get('/v1/accounts/earnings/referral/total').set(AUTH, KEY).expect(401)
  await unauthed.get('/v1/accounts/owner/transactions').set(AUTH, KEY).expect(401)
})

test('check settlement totals', async t => {
  t.plan(2)

  const client = await runtime.postgres.connect()
  try {
    await client.query('BEGIN')
    await insertFromSettlement(runtime, client, referralSettlement)
    await insertFromSettlement(runtime, client, _.assign({}, referralSettlement, {
      publisher: 'bar.com',
      amount: '12',
      probi: '12000000000000000000'
    }))
    await client.query('COMMIT')
    let type
    let body

    type = 'referrals'
    ;({ body } = await eyeshadeAgent.get(`/v1/accounts/settlements/${type}/total`).use(auth).send().expect(ok))
    t.deepEqual(body, [{
      channel: 'bar.com',
      paid: '12.000000000000000000',
      account_id: referralSettlement.owner
    }, {
      channel: 'foo.com',
      paid: '10.000000000000000000',
      account_id: referralSettlement.owner
    }])

    type = 'referrals'
    ;({ body } = await eyeshadeAgent.get(`/v1/accounts/settlements/${type}/total?order=asc`).use(auth).send().expect(ok))
    t.deepEqual(body, [{
      channel: 'foo.com',
      paid: '10.000000000000000000',
      account_id: referralSettlement.owner
    }, {
      channel: 'bar.com',
      paid: '12.000000000000000000',
      account_id: referralSettlement.owner
    }])
  } finally {
    client.release()
  }
})

test('check earnings total', async t => {
  t.plan(4)

  const client = await runtime.postgres.connect()
  try {
    await client.query('BEGIN')
    await insertFromReferrals(runtime, client, referrals)
    await insertFromReferrals(runtime, client, referralsBar)
    await client.query('COMMIT')
    let type
    let body

    type = 'referrals'
    ;({ body } = await eyeshadeAgent.get(`/v1/accounts/earnings/${type}/total`).use(auth).send().expect(ok))
    t.deepEqual(body, [{
      channel: 'bar.com',
      earnings: '12.000000000000000000',
      account_id: ownerId
    }, {
      channel: 'foo.com',
      earnings: '10.000000000000000000',
      account_id: ownerId
    }])

    type = 'referrals'
    ;({ body } = await eyeshadeAgent.get(`/v1/accounts/earnings/${type}/total?order=asc`).use(auth).send().expect(ok))
    t.deepEqual(body, [{
      channel: 'foo.com',
      earnings: '10.000000000000000000',
      account_id: ownerId
    }, {
      channel: 'bar.com',
      earnings: '12.000000000000000000',
      account_id: ownerId
    }])
  } catch (e) {
    client.release()
    throw e
  }

  try {
    const { body } = await eyeshadeAgent.get(`/v1/accounts/${encodeURIComponent(ownerId)}/transactions`)
    t.true(body.length >= 1)
    const count = body.reduce((memo, transaction) => _.keys(transaction).reduce((memo, key) => {
      return memo + (transaction[key] == null ? 1 : 0)
    }, memo), 0)
    t.is(count, 0)
  } finally {
    client.release()
  }
})

test('create ads payment fails if bad values are given', async (t) => {
  t.plan(0)

  const paymentId = uuidV4().toLowerCase()
  const transactionId = uuidV4().toLowerCase()
  const url = `/v1/accounts/${paymentId}/transactions/ads/${transactionId}`

  await eyeshadeAgent
    .put(url)
    .send({})
    .expect(400)

  await eyeshadeAgent
    .put(url)
    .send({ amount: 0 })
    .expect(400)

  await eyeshadeAgent
    .put(url)
    .send({ amount: 5 })
    .expect(400)
})

test('ads payment api inserts a transaction into the table and errs on subsequent tries', async (t) => {
  t.plan(0)

  const paymentId = uuidV4().toLowerCase()
  const transactionId = uuidV4().toLowerCase()
  const url = `/v1/accounts/${paymentId}/transactions/ads/${transactionId}`
  const payload = {
    amount: '1'
  }

  await eyeshadeAgent
    .put(url)
    .send(payload)
    .expect(ok)

  await eyeshadeAgent
    .put(url)
    .send(payload)
    .expect(409)
})

test('a uuid can be sent as an account id', async (t) => {
  t.plan(2)
  let response

  const uuid = uuidV4()
  const url = `/v1/accounts/${uuid}/transactions`
  response = await eyeshadeAgent.get(url).send().expect(ok)
  t.deepEqual(response.body, [], 'no txs matched')

  const transaction = {
    id: uuidV4(),
    createdAt: +(new Date()) / 1000,
    description: 'a random manual tx',
    transactionType: 'manual',
    documentId: uuidV4(),
    fromAccount: toOwnerId,
    fromAccountType: 'uphold',
    toAccount: uuid,
    toAccountType: 'uphold',
    amount: 1
  }
  await insertTransaction(runtime, runtime.postgres, transaction)
  response = await eyeshadeAgent.get(url).send().expect(ok)
  const { body } = response
  t.is(body.length, 1, 'one tx is matched')
})

test('an empty channel can exist', async (t) => {
  t.plan(3)
  let response

  const url = `/v1/accounts/${encodeURIComponent(ownerId)}/transactions`
  response = await eyeshadeAgent.get(url).send().expect(ok)
  t.deepEqual(response.body, [], 'no tx matched')

  const transaction = {
    id: uuidV4(),
    createdAt: +(new Date()) / 1000,
    description: 'a random manual tx',
    transactionType: 'manual',
    documentId: uuidV4(),
    fromAccount: toOwnerId,
    fromAccountType: 'uphold',
    toAccount: ownerId,
    toAccountType: 'uphold',
    amount: 1
  }
  await insertTransaction(runtime, runtime.postgres, transaction)
  response = await eyeshadeAgent.get(url).send().expect(ok)
  const { body } = response
  const tx = body[0]
  t.is(body.length, 1, 'only one tx')
  t.is(tx.channel, '', 'channel can be empty')
})
