'use strict'

import { serial as test } from 'ava'
import _ from 'underscore'
import uuidV4 from 'uuid/v4'
import {
  serverContext,
  cleanDbs,
  braveYoutubeOwner,
  ok
} from '../utils'

import dotenv from 'dotenv'
dotenv.config()

test.before(serverContext)
test.afterEach.always(cleanDbs)

test('eyeshade PUT /v1/owners/{owner}/wallet with uphold parameters', async t => {
  t.plan(14)
  const { runtime, agent } = t.context.eyeshade
  const owners = runtime.database.get('owners', () => {})
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
  await agent.put(ownerWalletUrl)
    .send(dataOwnerWalletParams)
    .expect(200)

  t.is(await owners.count(dbSelector), 1, 'can add owner')

  let owner = await owners.findOne(dbSelector)
  t.is(_.isObject(owner.parameters), true, 'wallet has uphold parameters')
  t.is(owner.authorized, true, 'owner is authorized')

  const { body } = await agent.get(ownerWalletUrl)
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
  const { agent } = t.context.eyeshade

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
  await agent.put(walletUrl).send(data).expect(ok)

  await createCard(agent, braveYoutubeOwner, 'BAT')
  const { body: wallet1 } = await agent.get(walletUrl)
    .send().expect(200)
  checkRates(wallet1)

  await createCard(agent, braveYoutubeOwner, 'XAU')
  const { body: wallet2 } = await agent.get(walletUrl)
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
  const { agent } = t.context.eyeshade
  const id = uuidV4()
  const badOwner = `publishers#uuid:${id}`
  const badEncoding = encodeURIComponent(badOwner)
  const badURL = `/v1/owners/${badEncoding}/wallet`

  await agent
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
  await agent.put(badURL)
    .send(dataOwnerWalletParams)
    .expect(200)

  const { body } = await agent
    .get(badURL)
    .send()
    .expect(200)
  t.deepEqual(body.status, {
    provider: 'uphold',
    action: 're-authorize'
  }, 'let client know a reauthorize is needed / that the token is bad')
})

function createCard (agent, owner, currency) {
  const encodedOwner = encodeURIComponent(owner)
  const createCardData = { currency }
  const cardUrl = `/v3/owners/${encodedOwner}/wallet/card`
  return agent.post(cardUrl).send(createCardData).expect(ok)
}
