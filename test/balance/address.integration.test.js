'use strict'

import {
  serial as test
} from 'ava'
import uuidV4 from 'uuid/v4'
import _ from 'underscore'
import { configuration } from '../../balance/controllers/address'
import {
  serverContext,
  debug,
  cleanDbs,
  ok
} from '../utils'

const parameters = { adFree: { fee: { USD: 5 }, days: 30 } }
const altcurrency = 'BAT'
const probi = '0'
const balanceString = '0.0000'
const unconfirmed = '0.0000'
const grants = []
const httpSigningPubKey = 'fake'

test.before(serverContext)
test.afterEach.always(cleanDbs)

test('a value can be cached', async (t) => {
  const { paymentId, model } = await insertWallet(t.context.ledger.runtime)
  const expectation = {
    altcurrency,
    probi,
    balance: balanceString,
    unconfirmed,
    parameters,
    grants
  }
  const firstValue = await getCached(t.context.balance.runtime, paymentId)
  t.is(firstValue, null, 'value is empty to start')
  const {
    body: retrieved
  } = await t.context.balance.agent
    .get(`/v2/wallet/${paymentId}/balance`)
    .expect(ok)
  t.deepEqual(expectation, _.omit(retrieved, ['rates']), 'value was inserted')
  const cached = await getCached(t.context.balance.runtime, paymentId)
  t.deepEqual(Object.assign({
    addresses: model.addresses,
    paymentStamp: 0,
    httpSigningPubKey
  }, expectation), _.omit(cached, ['rates']), 'result was cached')
})

test('a cached value can be removed', async (t) => {
  const { paymentId } = await insertWallet(t.context.ledger.runtime)
  await t.context.balance.agent
    .get(`/v2/wallet/${paymentId}/balance`)
    .expect(ok)
  const retrieved = await getCached(t.context.balance.runtime, paymentId)
  t.true(_.isObject(retrieved), 'a value was inserted')
  await t.context.balance.agent
    .del(`/v2/wallet/${paymentId}/balance`)
    .expect(ok)
  const emptied = await getCached(t.context.balance.runtime, paymentId)
  t.is(emptied, null, 'cached value is empty')
})

test('a cached card id points to the payment id data', async (t) => {
  const { paymentId, model } = await insertWallet(t.context.ledger.runtime)
  await t.context.balance.agent
    .get(`/v2/wallet/${paymentId}/balance`)
    .expect(ok)
  const retrieved = await getCached(t.context.balance.runtime, model.providerId, 'link')
  t.is(retrieved, paymentId, 'the card id points to the payment id')
})

async function getCached (runtime, id, prefixkey = 'wallet') {
  const { cache } = configuration
  const cached = await runtime.cache.get(id, cache[prefixkey])
  if (!cached) {
    return cached
  }
  const first = cached[0]
  if (first === '{' || first === '[') {
    return JSON.parse(cached)
  } else {
    return cached
  }
}

async function insertWallet (runtime, extension = {}) {
  const paymentId = uuidV4()
  const providerId = process.env.BAT_ADS_PAYOUT_ADDRESS
  const model = Object.assign({
    paymentId,
    altcurrency,
    httpSigningPubKey,
    grants,
    provider: 'uphold',
    defaultCurrency: 'BAT',
    providerId,
    addresses: {
      CARD_ID: providerId
    },
    parameters: {
      access_token: process.env.UPHOLD_ACCESS_TOKEN,
      scope: 'cards:read user:read'
    }
  }, extension)
  const wallets = runtime.database.get('wallets', debug)
  await wallets.insert(model)
  return {
    paymentId,
    model
  }
}
