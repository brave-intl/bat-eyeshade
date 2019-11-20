'use strict'

import { serial as test } from 'ava'
import _ from 'underscore'
import uuidV4 from 'uuid/v4'
import {
  agents,
  cleanDbs,
  cleanEyeshadeDb,
  braveYoutubeOwner,
  ok
} from '../utils'

import dotenv from 'dotenv'
dotenv.config()

const collections = ['owners', 'publishers', 'tokens']

test.after(cleanDbs)
test.beforeEach(async (t) => {
  const db = await cleanEyeshadeDb(collections)
  collections.forEach((name) => {
    t.context[name] = db.collection(name)
  })
})

test('eyeshade PUT /v1/owners/{owner}/wallet with uphold parameters', async t => {
  t.plan(14)
  const { owners } = t.context
  const OWNER = 'publishers#uuid:8f3ae7ad-2842-53fd-8b63-c843afe1a33b'
  const SCOPE = 'cards:read user:read'

  const dbSelector = {
    owner: OWNER
  }
  const encodedOwner = encodeURIComponent(OWNER)
  const ownerWalletUrl = `/v1/owners/${encodedOwner}/wallet`

  t.is(await owners.count(dbSelector), 0, 'sanity')

  const dataOwnerWalletParams = {
    provider: 'uphold',
    parameters: {
      access_token: process.env.UPHOLD_ACCESS_TOKEN,
      scope: SCOPE
    }
  }
  await agents.eyeshade.global.put(ownerWalletUrl)
    .send(dataOwnerWalletParams)
    .expect(200)

  t.is(await owners.count(dbSelector), 1, 'can add owner')

  let owner = await owners.findOne(dbSelector)
  t.is(_.isObject(owner.parameters), true, 'wallet has uphold parameters')
  t.is(owner.authorized, true, 'owner is authorized')

  const { body } = await agents.eyeshade.global.get(ownerWalletUrl)
    .send().expect(200)
  const { wallet } = body
  const {
    authorized,
    isMember,
    id,
    availableCurrencies,
    possibleCurrencies,
    scope
  } = wallet

  t.is(authorized, true, 'sanity')
  t.is(isMember, true, 'sanity')
  t.true(_.isString(id), 'an id is returned on the wallet object')
  t.is(Array.isArray(availableCurrencies), true, 'get wallet returns currencies we have a card for')
  // since we're reusing the test ledger wallet, this should always be true
  t.is(availableCurrencies.indexOf('BAT') !== -1, true, 'wallet has a BAT card')
  // hopefully no one creates a JPY card on the test ledger wallet :)
  t.is(availableCurrencies.indexOf('JPY'), -1, 'wallet does not have a JPY card')

  t.is(Array.isArray(possibleCurrencies), true, 'get wallet returns currencies we could create a card for')
  t.is(possibleCurrencies.indexOf('BAT') !== -1, true, 'wallet can have a BAT card')
  t.is(possibleCurrencies.indexOf('JPY') !== -1, true, 'wallet can have a JPY card')
  t.is(scope, SCOPE, 'get wallet returns authorization scope')
})

test('eyeshade: create brave youtube channel and owner, verify with uphold, add BAT card', async t => {
  const encodedOwner = encodeURIComponent(braveYoutubeOwner)

  const walletUrl = `/v1/owners/${encodedOwner}/wallet`
  const parameters = {
    access_token: process.env.UPHOLD_ACCESS_TOKEN,
    show_verification_status: false,
    defaultCurrency: 'DASH'
  }
  const data = {
    provider: 'uphold',
    parameters
  }
  await agents.eyeshade.global.put(walletUrl).send(data).expect(ok)

  await createCard(braveYoutubeOwner, 'BAT')
  const { body: wallet1 } = await agents.eyeshade.global.get(walletUrl)
    .send().expect(200)
  checkRates(wallet1)

  await createCard(braveYoutubeOwner, 'XAU')
  const { body: wallet2 } = await agents.eyeshade.global.get(walletUrl)
    .send().expect(200)
  checkRates(wallet2)

  function checkRates (wallet) {
    const { rates } = wallet
    const keys = _.keys(rates)
    for (let ticker of keys) {
      t.true(_.isString(rates[ticker]), 'is a string')
    }
  }
})

test('eyeshade: missing owners send back proper status', async (t) => {
  t.plan(1)
  const id = uuidV4()
  const badOwner = `publishers#uuid:${id}`
  const badEncoding = encodeURIComponent(badOwner)
  const badURL = `/v1/owners/${badEncoding}/wallet`

  await agents.eyeshade.global
    .get(badURL)
    .send()
    .expect(404)

  const SCOPE = 'cards:read user:read'
  const dataOwnerWalletParams = {
    provider: 'uphold',
    parameters: {
      access_token: process.env.UPHOLD_ACCESS_TOKEN + 'fake',
      scope: SCOPE
    }
  }
  await agents.eyeshade.global.put(badURL)
    .send(dataOwnerWalletParams)
    .expect(200)

  const { body } = await agents.eyeshade.global
    .get(badURL)
    .send()
    .expect(200)
  t.deepEqual(body.status, {
    provider: 'uphold',
    action: 're-authorize'
  }, 'let client know a reauthorize is needed / that the token is bad')
})

test('a card can be created from endpoint', async (t) => {
  t.plan(1)
  const id = uuidV4()
  const badOwner = `publishers#uuid:${id}`
  const badEncoding = encodeURIComponent(badOwner)
  const badURL = `/v1/owners/${badEncoding}/wallet`
  const postURL = `/v3/owners/${badEncoding}/wallet/card`
  const currency = 'BAT'
  const label = uuidV4()
  const payload = {
    currency,
    label
  }
  await agents.eyeshade.global
    .post(postURL)
    .send(payload)
    .expect(422)

  const SCOPE = 'cards:read user:read'
  const dataOwnerWalletParams = {
    provider: 'uphold',
    parameters: {
      access_token: process.env.UPHOLD_ACCESS_TOKEN,
      scope: SCOPE
    }
  }
  await agents.eyeshade.global.put(badURL)
    .send(dataOwnerWalletParams)
    .expect(200)

  const { body } = await agents.eyeshade.global
    .post(postURL)
    .send(payload)
    .expect(200)
  t.deepEqual({}, body, 'an empty object is sent back')
})

function createCard (owner, currency) {
  const encodedOwner = encodeURIComponent(owner)
  const createCardData = { currency }
  const cardUrl = `/v3/owners/${encodedOwner}/wallet/card`
  return agents.eyeshade.global.post(cardUrl).send(createCardData).expect(ok)
}
