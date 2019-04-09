'use strict'
import { serial as test } from 'ava'
import uuidV4 from 'uuid/v4'
import _ from 'underscore'
import {
  Runtime
} from 'bat-utils'
import {
  ok,
  status,
  eyeshadeAgent,
  braveYoutubePublisher,
  braveYoutubeOwner,
  cleanDbs,
  cleanPgDb
} from '../utils'
import {
  removeReferral
} from '../../eyeshade/lib/referrals'

const runtime = new Runtime({
  altcurrency: 'BAT',
  referrals: {
    amount: 5,
    currency: 'USD'
  },
  postgres: {
    url: process.env.BAT_POSTGRES_URL
  },
  currency: {
    url: process.env.BAT_RATIOS_URL,
    access_token: process.env.BAT_RATIOS_TOKEN
  }
})
const {
  BigNumber
} = runtime.currency

test.afterEach.always(cleanDbs)
test.afterEach.always(cleanPgDb(runtime.postgres))

test('404s when transaction does not exist', async (t) => {
  t.plan(0)

  const id = uuidV4()

  await eyeshadeAgent
    .get(url(id))
    .expect(status(404))
})

test('can add a referral', async (t) => {
  t.plan(5)
  const id = uuidV4().toLowerCase()
  const uri = url(id)
  const referrals = [{
    ownerId: braveYoutubeOwner,
    channelId: braveYoutubePublisher
  }]

  const {
    body: inserted
  } = await eyeshadeAgent
    .put(uri)
    .send(referrals)
    .expect(ok)

  const {
    body
  } = await eyeshadeAgent
    .get(uri)
    .expect(ok)

  t.deepEqual(inserted, body)
  const ratio = await runtime.currency.ratio('fiat/USD', 'alt/BAT')
  const one = inserted[0]
  const amount = new BigNumber(ratio).times(5)
  t.true(amount.toString() > 0, 'probi are recorded')
  t.is(inserted.length, 1, 'only one transaction inserted')
  t.is(amount.round().toString(), new BigNumber(one.amount).round().toString(), '$5 in bat are transferred')
  const subset = _.omit(one, ['amount'])
  t.deepEqual(subset, {
    channelId: braveYoutubePublisher,
    ownerId: braveYoutubeOwner,
    transactionId: id
  }, 'transaction is recorded')
  await removeReferral(runtime, id)
})

test('does not allow duplicate referrals when transactionId is same', async (t) => {
  t.plan(0)
  const id = uuidV4()
  const uri = url(id)
  const referrals = [{
    ownerId: braveYoutubeOwner,
    channelId: braveYoutubePublisher
  }]

  await eyeshadeAgent
    .put(uri)
    .send(referrals)
    .expect(ok)

  await eyeshadeAgent
    .put(uri)
    .send(referrals)
    .expect(status(422))

  await removeReferral(runtime, id)
})

test('allows extra data', async (t) => {
  t.plan(0)
  const id = uuidV4()
  const uri = url(id)
  const referrals = [{
    ownerId: braveYoutubeOwner,
    channelId: braveYoutubePublisher,
    downloadId: uuidV4(),
    platform: 'android',
    finalized: (new Date()).toISOString()
  }]

  await eyeshadeAgent
    .put(uri)
    .send(referrals)
    .expect(ok)

  await removeReferral(runtime, id)
})

function url (id) { return `/v1/referrals/${id}` }
