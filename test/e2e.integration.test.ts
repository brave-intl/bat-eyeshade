'use strict'

import BigNumber from 'bignumber.js'
import UpholdSDK from '@uphold/uphold-sdk-javascript'
import anonize from 'node-anonize2-relic'
import crypto from 'crypto'
import { serial as test } from 'ava'
import tweetnacl from 'tweetnacl'
import uuidV4 from 'uuid/v4'
import { sign } from 'http-request-signature'
import _ from 'underscore'
import dotenv from 'dotenv'
import extrasUtils from 'bat-utils/lib/extras-utils'
import Postgres from 'bat-utils/lib/runtime-postgres'
import Queue from 'bat-utils/lib/runtime-queue'
import {
  makeSettlement,
  cleanDbs,
  cleanPgDb,
  eyeshadeAgent,
  ledgerAgent,
  ok,
  braveYoutubeOwner,
  braveYoutubePublisher,
  createSurveyor,
  debug,
  statsUrl,
  connectToDb
} from './utils'
import reportsWorkers from '../eyeshade/workers/reports'

const {
  timeout,
  uint8tohex,
  justDate
} = extrasUtils
const {
  freezeOldSurveyors
} = reportsWorkers

dotenv.config()

const postgres = new Postgres({ postgres: { url: process.env.BAT_POSTGRES_URL } })
const queue = new Queue({ queue: { rsmq: process.env.BAT_REDIS_URL } })
const runtime = { postgres, queue }

const upholdBaseUrls = {
  'prod': 'https://api.uphold.com',
  'sandbox': 'https://api-sandbox.uphold.com'
}
const environment = process.env.UPHOLD_ENVIRONMENT || 'sandbox'
const uphold = new UpholdSDK({ // eslint-disable-line new-cap
  baseUrl: upholdBaseUrls[environment],
  clientId: 'none',
  clientSecret: 'none'
})
const donorCardId = process.env.UPHOLD_DONOR_CARD_ID

const statsURL = statsUrl()
const balanceURL = '/v1/accounts/balances'
const settlementURL = '/v2/publishers/settlement'
const grantsURL = '/v2/grants'

test.afterEach.always(async () => { await cleanDbs() })

test('ledger : user contribution workflow with uphold BAT wallet', async t => {
  // Create surveyors
  const probi12 = (new BigNumber(12)).times(1e18).toString()
  const surveyorId = (await createSurveyor({ rate: 1, votes: 12 })).body.surveyorId

  // Create user wallet
  let response, body
  let [viewingId, keypair, personaCredential, paymentId, userCardId] = await createUserWallet(t)

  // Fund user Uphold wallet
  let amountFunded = await fundUserWallet(t, personaCredential, paymentId, userCardId)

  // Purchase votes
  await sendUserTransaction(t, paymentId, amountFunded, userCardId, donorCardId, keypair, surveyorId, viewingId)
  response = await ledgerAgent.get(statsURL).expect(ok)
  t.deepEqual(response.body, [{
    activeGrant: 0,
    anyFunds: 1,
    contributed: 1,
    created: justDate(new Date()),
    walletProviderBalance: '12000000000000000000',
    walletProviderFunded: 1,
    wallets: 1
  }])

  // Create voting credentials
  let [surveyorIds, viewingCredential] = await createVotingCredentials(t, viewingId)

  // look up surveyorIds to ensure that they belong to the correct cohorts
  const ledgerDB = await connectToDb('ledger')
  const surveyors = ledgerDB.collection('surveyors')

  let numControlSurveryors = 0
  let numGrantSurveyors = 0
  for (let surveyorId of surveyorIds) {
    let cohort = (await surveyors.findOne({surveyorId: surveyorId})).payload.cohort
    if (cohort === 'control') {
      numControlSurveryors += 1
    } else if (cohort === 'grant') {
      numGrantSurveyors += 1
    }
  }

  t.true(numControlSurveryors === parseInt(amountFunded))
  t.true(numGrantSurveyors === 0)

  // Submit votes
  const channels = [
    'wikipedia.org',
    'reddit.com',
    'youtube.com',
    'ycombinator.com',
    'google.com',
    'facebook.com',
    'gab.ai',
    'bit.tube',
    'duckduckgo.com',
    'everipedia.org',
    braveYoutubePublisher
  ]

  for (let i = 0; i < surveyorIds.length; i++) {
    const id = surveyorIds[i]
    response = await ledgerAgent
      .get('/v2/surveyor/voting/' + encodeURIComponent(id) + '/' + viewingCredential.parameters.userId)
      .expect(ok)

    const surveyor = new anonize.Surveyor(response.body)
    response = await ledgerAgent
      .put('/v2/surveyor/voting/' + encodeURIComponent(id))
      .send({'proof': viewingCredential.submit(surveyor, { publisher: channels[i % channels.length] })})
      .expect(ok)
  }

  response = await ledgerAgent.get(statsURL).expect(ok)
  t.deepEqual(response.body, [{
    activeGrant: 0,
    anyFunds: 1,
    contributed: 1,
    created: justDate(new Date()),
    walletProviderBalance: probi12,
    walletProviderFunded: 1,
    wallets: 1
  }], 'ensure the created contributions are reflected in stats endpoint')

  // check pending tx endpoint
  body = []
  while (!body.length) {
    await timeout(2000)
    ;({
      body
    } = await eyeshadeAgent.get(balanceURL)
      .query({
        pending: true,
        account: braveYoutubePublisher
      })
      .expect(ok))
  }
  t.deepEqual(body, [{
    account_id: braveYoutubePublisher,
    account_type: 'channel',
    balance: '1.000000000000000000'
  }], 'pending votes show up after small delay')
  ;({
    body
  } = await eyeshadeAgent.get(balanceURL)
    .query({
      pending: false,
      account: braveYoutubePublisher
    }))
  t.deepEqual(body, [], 'pending votes are not counted if pending is not true')
  ;({
    body
  } = await eyeshadeAgent.get(balanceURL)
    .query({
      account: braveYoutubePublisher
    }))
  t.deepEqual(body, [], 'endpoint defaults pending to false')

  // Create a publisher owner and settle balances to that owner
  await eyeshadeAgent.put(`/v1/owners/${encodeURIComponent(braveYoutubeOwner)}/wallet`)
    .send({ 'provider': 'uphold', 'parameters': {} })
    .expect(ok)

  let amount, entry
  const account = [braveYoutubePublisher]
  const query = { account }

  await freezeOldSurveyors(debug, runtime, -1)

  body = []
  do {
    await timeout(5000)
    ;({ body } = await eyeshadeAgent
      .get(balanceURL)
      .query(query)
      .expect(ok))
    entry = body[0]
  } while (!entry)

  t.true(entry.balance > 0)

  const newYear = new Date('2019-01-01')
  const settlement = makeSettlement('contribution', entry.balance, {
    executedAt: newYear.toISOString()
  })

  await eyeshadeAgent.post(settlementURL).send([settlement]).expect(ok)

  do {
    await timeout(5000)
    ;({ body } = await eyeshadeAgent
      .get(balanceURL)
      .query(query)
      .expect(ok))
    entry = body[0]
  } while (+entry.balance)

  const { balance } = entry
  t.true(balance.length > 1)
  t.is(+balance, 0)

  const select = `
SELECT *
FROM transactions
WHERE
    transaction_type = 'contribution_settlement';
`
  const {
    rows
  } = await postgres.query(select)

  t.deepEqual(rows.map((entry) => _.omit(entry, ['from_account', 'to_account', 'document_id', 'id'])), [{
    created_at: newYear,
    description: 'payout for contribution',
    transaction_type: 'contribution_settlement',
    from_account_type: 'owner',
    to_account_type: 'uphold',
    amount: '0.950000000000000000',
    channel: braveYoutubePublisher,
    settlement_currency: 'USD',
    settlement_amount: '1.000000000000000000'
  }])

  // ensure referral balances are computed correctly
  let transactions
  const encoded = encodeURIComponent(braveYoutubeOwner)
  const transactionsURL = `/v1/accounts/${encoded}/transactions`
  const referralKey = uuidV4().toLowerCase()
  const referralURL = '/v1/referrals/' + referralKey
  const referral = {
    ownerId: braveYoutubeOwner,
    channelId: braveYoutubePublisher,
    downloadId: uuidV4(),
    platform: 'android',
    finalized: (new Date()).toISOString()
  }
  const referrals = [referral]

  transactions = await getReferrals()
  t.deepEqual(transactions, [])

  await eyeshadeAgent
    .put(referralURL)
    .send(referrals)
    .expect(ok)

  transactions = []
  do {
    await timeout(5000)
    transactions = await getReferrals()
  } while (!transactions.length)

  const [tx] = transactions
  amount = tx.amount
  t.true(amount.length > 1)
  t.true(amount > 0)

  async function getReferrals () {
    const {
      body: transactions
    } = await eyeshadeAgent
      .get(transactionsURL)
      .expect(ok)
    return transactions.filter(({ transaction_type: type }) => type === 'referral')
  }
})

test('ledger : grant contribution workflow with uphold BAT wallet', async t => {
  // Create surveyors
  const surveyorId = (await createSurveyor({ rate: 1, votes: 12 })).body.surveyorId

  // Create promotion and grants
  const promotionId = '902e7e4d-c2de-4d5d-aaa3-ee8fee69f7f3'
  const grants = {
    'grants': [ 'eyJhbGciOiJFZERTQSIsImtpZCI6IiJ9.eyJhbHRjdXJyZW5jeSI6IkJBVCIsImdyYW50SWQiOiJhNDMyNjg1My04NzVlLTQ3MDgtYjhkNS00M2IwNGMwM2ZmZTgiLCJwcm9iaSI6IjMwMDAwMDAwMDAwMDAwMDAwMDAwIiwicHJvbW90aW9uSWQiOiI5MDJlN2U0ZC1jMmRlLTRkNWQtYWFhMy1lZThmZWU2OWY3ZjMiLCJtYXR1cml0eVRpbWUiOjE1MTUwMjkzNTMsImV4cGlyeVRpbWUiOjE4MzAzODkzNTN9.8M5dpr_rdyCURd7KBc4GYaFDsiDEyutVqG-mj1QRk7BCiihianvhiqYeEnxMf-F4OU0wWyCN5qKDTxeqait_BQ' ],
    'promotions': [{'active': true, 'priority': 0, 'promotionId': promotionId}]
  }
  await ledgerAgent.post(grantsURL).send(grants).expect(ok)

  // Create user wallet
  let response, err
  let [viewingId, keypair, , paymentId, userCardId] = await createUserWallet(t)

  // Request grant for user
  const ledgerDB = await connectToDb('ledger')
  let amountFunded = await requestGrant(t, paymentId, promotionId, ledgerDB)
  response = await ledgerAgent.get(statsURL).expect(ok)
  t.deepEqual(response.body, [{
    activeGrant: 1,
    anyFunds: 1,
    contributed: 0,
    created: justDate(new Date()),
    walletProviderBalance: '0',
    walletProviderFunded: 1,
    wallets: 1
  }])

  // Exchange grant for BAT and BAT for votes
  let payload = await sendUserTransaction(t, paymentId, amountFunded, userCardId, donorCardId, keypair, surveyorId, viewingId)
  response = await ledgerAgent.get(statsURL).expect(ok)
  t.deepEqual(response.body, [{
    activeGrant: 0,
    anyFunds: 1,
    contributed: 1,
    created: justDate(new Date()),
    walletProviderBalance: '0',
    walletProviderFunded: 0,
    wallets: 1
  }])

  // Create voting credentials
  let [surveyorIds, viewingCredential] = await createVotingCredentials(t, viewingId)

  // look up surveyorIds to ensure that they belong to the correct cohorts
  const surveyors = ledgerDB.collection('surveyors')
  let numControlSurveryors = 0
  let numGrantSurveyors = 0
  for (let surveyorId of surveyorIds) {
    let cohort = (await surveyors.findOne({surveyorId: surveyorId})).payload.cohort
    if (cohort === 'control') {
      numControlSurveryors += 1
    } else if (cohort === 'grant') {
      numGrantSurveyors += 1
    }
  }

  t.true(numControlSurveryors === 0)
  t.true(numGrantSurveyors === parseInt(amountFunded))

  // Submit votes
  await submitBatchedVotes(t, viewingCredential)
  do {
    response = await ledgerAgent
      .get(`/v2/wallet/${paymentId}?refresh=true&amount=${amountFunded}&altcurrency=BAT`)
    if (response.status === 503) await timeout(response.headers['retry-after'] * 1000)
  } while (response.status === 503)
  err = ok(response)
  if (err) throw err

  t.true(response.body.grants.length === 0)

  // unsync grant state between ledger and the grant server
  const data = {
    $set: { 'grants.$.status': 'active' }
  }
  const query = {
    'grants.promotionId': promotionId
  }
  const wallets = ledgerDB.collection('wallets')
  await wallets.findOneAndUpdate(query, data)

  do {
    response = await ledgerAgent
      .get(`/v2/wallet/${paymentId}?refresh=true&amount=${amountFunded}&altcurrency=BAT`)
    if (response.status === 503) await timeout(response.headers['retry-after'] * 1000)
    else if (response.body.balance === '0.0000') await timeout(500)
  } while (response.status === 503 || response.body.balance === '0.0000')
  err = ok(response)
  if (err) throw err

  t.true(response.body.grants.length > 0)

  do { // Contribution surveyor creation is handled asynchonously, this API will return 503 until ready
    if (response.status === 503) {
      await timeout(response.headers['retry-after'] * 1000)
    }
    response = await ledgerAgent
       .put('/v2/wallet/' + paymentId)
       .send(payload)
  } while (response.status === 503)

  t.is(response.status, 410)

  do {
    response = await ledgerAgent
      .get(`/v2/wallet/${paymentId}?refresh=true&amount=${amountFunded}&altcurrency=BAT`)
    if (response.status === 503) await timeout(response.headers['retry-after'] * 1000)
  } while (response.status === 503)
  err = ok(response)
  if (err) throw err

  t.true(response.body.grants.length === 0)

  // TODO test settlement flow
})

test('ledger : user + grant contribution workflow with uphold BAT wallet', async t => {
  // Create surveyors
  const surveyorId = (await createSurveyor({ rate: 1, votes: 12 })).body.surveyorId

  // Create promotion and grants
  const promotionId = '902e7e4d-c2de-4d5d-aaa3-ee8fee69f7f3'
  const grants = { // 30 BAT
    'grants': [ 'eyJhbGciOiJFZERTQSIsImtpZCI6IiJ9.eyJhbHRjdXJyZW5jeSI6IkJBVCIsImdyYW50SWQiOiJhNDMyNjg1My04NzVlLTQ3MDgtYjhkNS00M2IwNGMwM2ZmZTgiLCJwcm9iaSI6IjMwMDAwMDAwMDAwMDAwMDAwMDAwIiwicHJvbW90aW9uSWQiOiI5MDJlN2U0ZC1jMmRlLTRkNWQtYWFhMy1lZThmZWU2OWY3ZjMiLCJtYXR1cml0eVRpbWUiOjE1MTUwMjkzNTMsImV4cGlyeVRpbWUiOjE4MzAzODkzNTN9.8M5dpr_rdyCURd7KBc4GYaFDsiDEyutVqG-mj1QRk7BCiihianvhiqYeEnxMf-F4OU0wWyCN5qKDTxeqait_BQ' ],
    'promotions': [{'active': true, 'priority': 0, 'promotionId': promotionId}]
  }
  await ledgerAgent.post(grantsURL).send(grants).expect(ok)

  // Create user wallet
  let [viewingId, keypair, personaCredential, paymentId, userCardId] = await createUserWallet(t)

  // Fund user uphold wallet
  let amountFunded = await fundUserWallet(t, personaCredential, paymentId, userCardId)

  // Claim grant
  const ledgerDB = await connectToDb('ledger')
  let donateGrantAmount = await requestGrant(t, paymentId, promotionId, ledgerDB)
  let response = await ledgerAgent.get(statsURL).expect(ok)
  t.deepEqual(response.body, [{
    activeGrant: 1,
    anyFunds: 1,
    contributed: 0,
    created: justDate(new Date()),
    walletProviderBalance: '0',
    walletProviderFunded: 0,
    wallets: 1
  }])

  const desiredTxTotal = (parseInt(amountFunded) + parseInt(donateGrantAmount)).toString()

  // Exchange grant for BAT and BAT for votes
  await sendUserTransaction(t, paymentId, desiredTxTotal, userCardId, donorCardId, keypair, surveyorId, viewingId)
  response = await ledgerAgent.get(statsURL).expect(ok)
  t.deepEqual(response.body, [{
    activeGrant: 0,
    anyFunds: 1,
    contributed: 1,
    created: justDate(new Date()),
    walletProviderBalance: '12000000000000000000',
    walletProviderFunded: 1,
    wallets: 1
  }])

  // Create voting credentials
  let [ surveyorIds, , ] = await createVotingCredentials(t, viewingId)

  // look up surveyorIds to ensure that they belong to the correct cohorts
  const surveyors = ledgerDB.collection('surveyors')
  let numControlSurveryors = 0
  let numGrantSurveyors = 0
  for (let surveyorId of surveyorIds) {
    let cohort = (await surveyors.findOne({surveyorId: surveyorId})).payload.cohort
    if (cohort === 'control') {
      numControlSurveryors += 1
    } else if (cohort === 'grant') {
      numGrantSurveyors += 1
    }
  }

  t.true(numControlSurveryors === parseInt(amountFunded)) // 12
  t.true(numGrantSurveyors === parseInt(donateGrantAmount)) // 30
  t.true(surveyorIds.length === parseInt(desiredTxTotal)) // 42

  // TODO submit votes and test settlement flow
})

async function createUserWallet (t) {
  const personaId = uuidV4().toLowerCase()
  const viewingId = uuidV4().toLowerCase()
  let response, octets, headers, payload

  response = await ledgerAgent.get('/v2/registrar/persona').expect(ok)
  t.true(response.body.hasOwnProperty('registrarVK'))
  const personaCredential = new anonize.Credential(personaId, response.body.registrarVK)
  const keypair = tweetnacl.sign.keyPair()
  let body = {
    label: uuidV4().toLowerCase(),
    currency: 'BAT',
    publicKey: uint8tohex(keypair.publicKey)
  }
  octets = JSON.stringify(body)
  headers = {
    digest: 'SHA-256=' + crypto.createHash('sha256').update(octets).digest('base64')
  }
  headers['signature'] = sign({
    headers: headers,
    keyId: 'primary',
    secretKey: uint8tohex(keypair.secretKey)
  }, { algorithm: 'ed25519' })
  payload = { requestType: 'httpSignature',
    request: {
      body: body,
      headers: headers,
      octets: octets
    },
    proof: personaCredential.request()
  }

  response = await ledgerAgent.post('/v2/registrar/persona/' + personaCredential.parameters.userId)
    .send(payload).expect(ok)

  t.true(response.body.hasOwnProperty('wallet'))
  t.true(response.body.wallet.hasOwnProperty('paymentId'))
  t.true(response.body.wallet.hasOwnProperty('addresses'))
  t.true(response.body.hasOwnProperty('verification'))
  t.true(response.body.wallet.addresses.hasOwnProperty('BAT'))
  t.true(response.body.wallet.addresses.hasOwnProperty('BTC'))
  t.true(response.body.wallet.addresses.hasOwnProperty('CARD_ID'))
  t.true(response.body.wallet.addresses.hasOwnProperty('ETH'))
  t.true(response.body.wallet.addresses.hasOwnProperty('LTC'))

  const paymentId = response.body.wallet.paymentId
  const userCardId = response.body.wallet.addresses.CARD_ID

  personaCredential.finalize(response.body.verification)

  response = await ledgerAgent.get('/v2/wallet?publicKey=' + uint8tohex(keypair.publicKey))
    .expect(ok)

  t.true(response.body.paymentId === paymentId)

  return [viewingId, keypair, personaCredential, paymentId, userCardId]
}

async function fundUserWallet (t, personaCredential, paymentId, userCardId) {
  let response, err
  response = await ledgerAgent
    .get('/v2/surveyor/contribution/current/' + personaCredential.parameters.userId)
    .expect(ok)

  t.true(response.body.hasOwnProperty('surveyorId'))
  t.true(response.body.hasOwnProperty('payload'))
  t.true(response.body.payload.hasOwnProperty('adFree'))
  t.true(response.body.payload.adFree.hasOwnProperty('probi'))

  const donateAmt = new BigNumber(response.body.payload.adFree.probi).dividedBy('1e18').toNumber()

  response = await ledgerAgent.get(statsURL).expect(ok)
  t.deepEqual(response.body, [{
    activeGrant: 0,
    anyFunds: 0,
    created: justDate(new Date()),
    walletProviderBalance: '0',
    walletProviderFunded: 1,
    contributed: 0,
    wallets: 1
  }])

  do { // This depends on currency conversion rates being available, retry until they are available
    response = await ledgerAgent
      .get('/v2/wallet/' + paymentId + '?refresh=true&amount=1&currency=USD')
    if (response.status === 503) await timeout(response.headers['retry-after'] * 1000)
  } while (response.status === 503)
  err = ok(response)
  if (err) throw err

  t.true(response.body.hasOwnProperty('balance'))
  t.true(_.isString(response.body.httpSigningPubKey))
  t.is(response.body.balance, '0.0000')

  const desiredTxAmt = donateAmt.toFixed(4).toString()

  response = await ledgerAgent.get(statsURL).expect(ok)
  t.deepEqual(response.body, [{
    activeGrant: 0,
    anyFunds: 1,
    contributed: 0,
    created: justDate(new Date()),
    walletProviderBalance: '0',
    walletProviderFunded: 0,
    wallets: 1
  }])

  // have to do some hacky shit to use a personal access token
  uphold.storage.setItem('uphold.access_token', process.env.UPHOLD_ACCESS_TOKEN)

  await uphold.createCardTransaction(donorCardId,
    {'amount': desiredTxAmt, 'currency': 'BAT', 'destination': userCardId},
    true // commit tx in one swoop
  )

  return desiredTxAmt
}

async function requestGrant (t, paymentId, promotionId, ledgerDB) {
  // see if promotion is available
  let response = await ledgerAgent
    .get('/v2/grants')
    .expect(ok)

  t.true(response.body.hasOwnProperty('promotionId'))
  t.is(response.body.promotionId, promotionId)

  await ledgerAgent
    .get(`/v2/captchas/${paymentId}`)
    .set('brave-product', 'brave-core')
    .expect(ok)

  const wallets = ledgerDB.collection('wallets')
  const {
    captcha
  } = await wallets.findOne({ paymentId })

  response = await ledgerAgent
      .put(`/v2/grants/${paymentId}`)
      .send({
        promotionId,
        captchaResponse: {
          x: captcha.x,
          y: captcha.y
        }
      })
      .expect(ok)
  t.true(response.body.hasOwnProperty('probi'))

  const donateAmt = new BigNumber(response.body.probi).dividedBy('1e18').toNumber()
  const amountFunded = donateAmt.toString()

  return amountFunded
}

async function sendUserTransaction (t, paymentId, txAmount, userCardId, donorCardId, keypair, surveyorId, viewingId) {
  let response, err
  do {
    response = await ledgerAgent
      .get(`/v2/wallet/${paymentId}?refresh=true&amount=${txAmount}&altcurrency=BAT`)
    if (response.status === 503) await timeout(response.headers['retry-after'] * 1000)
    else if (response.body.balance === '0.0000') await timeout(500)
  } while (response.status === 503 || response.body.balance === '0.0000')
  err = ok(response)
  if (err) throw err

  t.is(Number(response.body.unsignedTx.denomination.amount), Number(txAmount))
  const { rates } = response.body
  t.true(_.isObject(rates))
  t.true(_.isNumber(rates.BTC))
  t.true(_.isNumber(rates.ETH))
  t.true(_.isNumber(rates.LTC))
  t.true(_.isNumber(rates.USD))
  t.true(_.isNumber(rates.EUR))

  // ensure that transactions out of the restricted user card require a signature
  // by trying to send back to the donor card
  await t.throwsAsync(uphold.createCardTransaction(userCardId,
    {'amount': txAmount, 'currency': 'BAT', 'destination': donorCardId},
    true // commit tx in one swoop
  ))

  const createPayload = setupCreatePayload({
    viewingId,
    surveyorId,
    keypair
  })
  const { unsignedTx } = response.body
  const { denomination, destination } = unsignedTx
  const { currency } = denomination
  const tooLowPayload = createPayload({
    destination,
    denomination: {
      amount: 0.1,
      currency
    }
  })
  await ledgerAgent
    .put('/v2/wallet/' + paymentId)
    .send(tooLowPayload)
    .expect(416)

  const justRightPayload = createPayload(response.body.unsignedTx)

  do { // Contribution surveyor creation is handled asynchonously, this API will return 503 until ready
    if (response.status === 503) {
      await timeout(response.headers['retry-after'] * 1000)
    }
    response = await ledgerAgent
      .put('/v2/wallet/' + paymentId)
      .send(justRightPayload)
  } while (response.status === 503)
  err = ok(response)
  if (err) throw err

  t.false(response.body.hasOwnProperty('satoshis'))
  t.true(response.body.hasOwnProperty('altcurrency'))
  t.true(response.body.hasOwnProperty('probi'))

  return justRightPayload
}

function setupCreatePayload ({
  surveyorId,
  viewingId,
  keypair
}) {
  return (unsignedTx) => {
    const octets = JSON.stringify(unsignedTx)
    const headers = {
      digest: 'SHA-256=' + crypto.createHash('sha256').update(octets).digest('base64')
    }
    headers['signature'] = sign({
      headers: headers,
      keyId: 'primary',
      secretKey: uint8tohex(keypair.secretKey)
    }, {
      algorithm: 'ed25519'
    })
    return {
      requestType: 'httpSignature',
      signedTx: {
        headers: headers,
        octets: octets
      },
      surveyorId: surveyorId,
      viewingId: viewingId
    }
  }
}

async function createVotingCredentials (t, viewingId) {
  let response, err
  response = await ledgerAgent
    .get('/v2/registrar/viewing')
    .expect(ok)

  t.true(response.body.hasOwnProperty('registrarVK'))
  const viewingCredential = new anonize.Credential(viewingId, response.body.registrarVK)

  do { // Contribution surveyor creation is handled asynchonously, this API will return 503 until ready
    if (response.status === 503) {
      await timeout(response.headers['retry-after'] * 1000)
    }
    response = await ledgerAgent
      .post('/v2/registrar/viewing/' + viewingCredential.parameters.userId)
      .send({ proof: viewingCredential.request() })
  } while (response.status === 503)
  err = ok(response)
  if (err) throw err

  t.true(response.body.hasOwnProperty('surveyorIds'))
  const surveyorIds = response.body.surveyorIds
  t.true(surveyorIds.length >= 5)
  viewingCredential.finalize(response.body.verification)

  return [surveyorIds, viewingCredential]
}

async function submitBatchedVotes (t, viewingCredential) {
  let response = await ledgerAgent
    .get(`/v2/batch/surveyor/voting/${viewingCredential.parameters.userId}`)
    .expect(ok)

  const bulkVotePayload = response.body.map(item => {
    const surveyor = new anonize.Surveyor(item)
    return {
      surveyorId: item.surveyorId,
      proof: viewingCredential.submit(surveyor, { publisher: 'basicattentiontoken.org' })
    }
  })

  await ledgerAgent
    .post('/v2/batch/surveyor/voting')
    .send(bulkVotePayload)
    .expect(ok)
}
