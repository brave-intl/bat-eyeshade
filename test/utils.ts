import dotenv from 'dotenv'
import supertest from 'supertest'
import mongodb from 'mongodb'
import querystring from 'querystring'
import _ from 'underscore'
import uuidV4 from 'uuid/v4'
import redis from 'redis'
import BigNumber from 'bignumber.js'
import extrasUtils from 'bat-utils/lib/extras-utils'
import Postgres from 'bat-utils/lib/runtime-postgres'
import SDebug from 'sdebug'
dotenv.config()
const { agent } = supertest
const { stringify } = querystring
const { timeout } = extrasUtils
const debug = new SDebug('test')

const postgres = new Postgres({
  postgres: {
    url: process.env.BAT_POSTGRES_URL
  }
})

const braveYoutubeOwner = 'publishers#uuid:' + uuidV4().toLowerCase()
const braveYoutubePublisher = `youtube#channel:UCFNTTISby1c_H-rm5Ww5rZg`

const eyeshadeCollections = [
  'grants',
  'owners',
  'restricted',
  'publishers',
  'tokens',
  'referrals',
  'surveyors',
  'settlements'
]
const ledgerCollections = [
  'owners',
  'referrals',
  'publishers',
  'tokens',
  'grants',
  'wallets',
  'surveyors',
  'settlements',
  'publishersV2',
  'publishersX',
  'restricted'
]

const tkn = process.env.TOKEN_LIST.split(',')[0]
const token = `Bearer ${tkn}`

const createFormURL = (params) => (pathname, p) => `${pathname}?${stringify(_.extend({}, params, p || {}))}`

const formURL = createFormURL({
  format: 'json',
  summary: true,
  balance: true,
  verified: true,
  amount: 0,
  currency: 'USD'
})

const AUTH_KEY = 'Authorization'
const eyeshadeAgent = agent(process.env.BAT_EYESHADE_SERVER).set(AUTH_KEY, token)
const ledgerAgent = agent(process.env.BAT_LEDGER_SERVER).set(AUTH_KEY, token)
const balanceAgent = agent(process.env.BAT_BALANCE_SERVER).set(AUTH_KEY, token)

const status = (expectation) => (res: any) => {
  if (!res) {
    return new Error('no response object given')
  }
  const { status, body } = res
  if (status !== expectation) {
    return new Error(JSON.stringify(Object.assign({}, body, {
      url: res.request.url,
      method: res.request.method
    }), null, 2).replace(/\\n/g, '\n'))
  }
}

const ok = (res) => status(200)(res)

// write an abstraction for the do while loops
const tryAfterMany = async (ms, theDoBlock, theCatchBlock) => {
  let tryagain = null
  let result = null
  do {
    tryagain = false
    try {
      result = await theDoBlock()
      tryagain = theCatchBlock(null, result)
    } catch (e) {
      tryagain = theCatchBlock(e, result)
    }
    if (tryagain) {
      await timeout(ms)
    }
  } while (tryagain)
  return result
}

const fetchReport = async ({ url, isCSV }) => {
  return tryAfterMany(5000,
    () => agent('').get(url).send(),
    (e, result) => {
      if (e) {
        throw e
      }
      const { statusCode, headers } = result
      if (isCSV) {
        return headers['content-type'].indexOf('text/csv') === -1
      }
      if (statusCode < 400) {
        return false
      }
      const tryagain = statusCode === 404
      if (!tryagain) {
        throw result
      }
      return tryagain
    })
}

/**
 * assert that values v1 and v2 differ by no more than tol
 **/
const assertWithinBounds = (t, v1, v2, tol, msg) => {
  if (v1 > v2) {
    t.true((v1 - v2) <= tol, msg)
  } else {
    t.true((v2 - v1) <= tol, msg)
  }
}
const dbUri = (db) => `${process.env.BAT_MONGODB_URI}/${db}`
const connectToDb = async (key) => mongodb.MongoClient.connect(dbUri(key))

const cleanDb = async (key, collections) => {
  const db = await connectToDb(key)
  await db.dropDatabase()
  return db
}
const cleanLedgerDb = async () => {
  return cleanDb('ledger', ledgerCollections)
}
const cleanEyeshadeDb = async () => {
  return cleanDb('eyeshade', eyeshadeCollections)
}

const cleanRedisDb = async () => {
  const url = process.env.BAT_GRANT_REDIS_URL
  const client = redis.createClient(url)
  await new Promise((resolve, reject) => {
    client.on('ready', () => {
      client.flushdb((err) => {
        err ? reject(err) : resolve()
      })
    }).on('error', (err) => reject(err))
  })
}

export {
  makeSettlement,
  createSurveyor,
  getSurveyor,
  fetchReport,
  formURL,
  ok,
  debug,
  status,
  eyeshadeAgent,
  ledgerAgent,
  balanceAgent,
  assertWithinBounds,
  connectToDb,
  dbUri,
  cleanDb,
  cleanDbs,
  cleanPgDb,
  cleanLedgerDb,
  cleanEyeshadeDb,
  cleanRedisDb,
  braveYoutubeOwner,
  braveYoutubePublisher,
  statsUrl
}

function cleanDbs () {
  return Promise.all([
    cleanPgDb(),
    cleanEyeshadeDb(),
    cleanLedgerDb(),
    cleanRedisDb()
  ])
}

function cleanPgDb () {
  return Promise.all([
    postgres.query('DELETE from potential_payments_ads;'),
    postgres.query('DELETE from payout_reports_ads;'),
    postgres.query('DELETE from transactions;'),
    postgres.query('DELETE from surveyor_groups;'),
    postgres.query('DELETE from votes;')
  ]).then(() => postgres.query('REFRESH MATERIALIZED VIEW account_balances;'))
}

function getSurveyor (id?) {
  return ledgerAgent
    .get(`/v2/surveyor/contribution/${id || 'current'}`)
    .expect(ok)
}

function createSurveyor (options: any = {}) {
  const {
    votes = 1,
    rate = 1,
    // probi is optional
    probi
  } = options
  const url = '/v2/surveyor/contribution'
  const data = {
    adFree: {
      fee: { USD: 5 },
      votes,
      altcurrency: 'BAT',
      probi: probi || new BigNumber(votes * rate).times('1e18').toString()
    }
  }
  return ledgerAgent.post(url).send(data).expect(ok)
}

function statsUrl () {
  const dateObj = new Date()
  const dateISO = dateObj.toISOString()
  const date = dateISO.split('T')[0]
  const dateObj2 = new Date(date)
  const DAY = 1000 * 60 * 60 * 24
  // two days just in case this happens at midnight
  // and the tests occur just after
  const dateFuture = new Date(+dateObj2 + (2 * DAY))
  const futureISO = dateFuture.toISOString()
  const future = futureISO.split('T')[0]
  return `/v2/wallet/stats/${date}/${future}`
}

function makeSettlement (type, balance, overwrites = {}) {
  const amount = new BigNumber(balance).times(1e18)
  const fees = amount.times(0.05)
  const probi = amount.times(0.95)
  return Object.assign({
    type,
    currency: 'USD',
    altcurrency: 'BAT',
    fees: fees.toString(),
    probi: probi.toString(),
    amount: amount.dividedBy(1e18).toString(),
    publisher: braveYoutubePublisher,
    owner: braveYoutubeOwner,
    transactionId: uuidV4(),
    address: uuidV4(),
    hash: uuidV4()
  }, overwrites)
}
