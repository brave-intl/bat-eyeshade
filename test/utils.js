const dotenv = require('dotenv')
dotenv.config()
const agent = require('supertest').agent
const mongodb = require('mongodb')
const stringify = require('querystring').stringify
const _ = require('underscore')
const uuidV4 = require('uuid/v4')
const redis = require('redis')
const BigNumber = require('bignumber.js')
const {
  timeout
} = require('bat-utils/lib/extras-utils')
const {
  Runtime
} = require('bat-utils')
const ledgerApp = require('../ledger/app')
const eyeshadeApp = require('../eyeshade/app')
const balanceApp = require('../balance/app')
const SDebug = require('sdebug')
const debug = new SDebug('test')

const braveYoutubeOwner = 'publishers#uuid:' + uuidV4().toLowerCase()
const braveYoutubePublisher = `youtube#channel:UCFNTTISby1c_H-rm5Ww5rZg`
let completedSetupServers = null
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
const ledgerRuntime = makeRuntime('ledger')
const ledgerServer = async (port, runtime) => ledgerApp({ port }, runtime)
const eyeshadeRuntime = makeRuntime('eyeshade')
const eyeshadeServer = async (port, runtime) => eyeshadeApp({ port }, runtime)
const balanceRuntime = makeRuntime('balance')
const balanceServer = async (port, runtime) => balanceApp({ port }, runtime)

const status = (expectation) => (res) => {
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
const cleanLedgerDb = async (collections) => {
  return cleanDb('ledger', collections || ledgerCollections)
}
const cleanEyeshadeDb = async (collections) => {
  return cleanDb('eyeshade', collections || eyeshadeCollections)
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

module.exports = {
  ledgerServer,
  eyeshadeServer,
  balanceServer,
  ledgerRuntime,
  eyeshadeRuntime,
  balanceRuntime,
  serverContext,
  setupServers,
  makeRuntime,
  AUTH_KEY,
  token,
  makeSettlement,
  createSurveyor,
  getSurveyor,
  fetchReport,
  formURL,
  ok,
  debug,
  status,
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

async function cleanPgDb () {
  const { postgres } = eyeshadeRuntime
  return Promise.all([
    postgres.query('DELETE from transactions;'),
    postgres.query('DELETE from surveyor_groups;'),
    postgres.query('DELETE from votes;')
  ]).then(() => postgres.query('REFRESH MATERIALIZED VIEW account_balances;'))
}

function getSurveyor (agent, id) {
  return agent
    .get(`/v2/surveyor/contribution/${id || 'current'}`)
    .expect(ok)
}

function createSurveyor (agent, options = {}) {
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
  return agent.post(url).send(data).expect(ok)
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

function makeRuntime (service, extension = {}) {
  const REDIS_KEY = `BAT_${service.toUpperCase()}_REDIS_URL`
  const {
    [REDIS_KEY]: BAT_REDIS_URL,
    SERVICE,
    DYNO,
    BAT_EYESHADE_REDIS_URL,
    TESTING_COHORTS,
    BAT_RATIOS_URL,
    BAT_RATIOS_TOKEN,
    REFERRALS_CURRENCY,
    REFERRALS_AMOUNT,
    BAT_POSTGRES_URL,
    REDEEMER_URL,
    REDEEMER_TOKEN,
    CAPTCHA_URL,
    CAPTCHA_TOKEN,
    CAPTCHA_BYPASS_TOKEN,
    UPHOLD_ACCESS_TOKEN,
    UPHOLD_CLIENT_ID,
    UPHOLD_CLIENT_SECRET,
    UPHOLD_ENVIRONMENT,
    BAT_SETTLEMENT_ADDRESS,
    BAT_ADS_PAYOUT_ADDRESS,
    SENTRY_DSN,
    HEROKU_SLUG_COMMIT,
    HEROKU_APP_NAME,
    BAT_LEDGER_SERVER,
    BAT_MONGODB_URI
  } = process.env
  // console.trace(BAT_MONGODB_URI, service)
  const config = Object.assign({
    testingCohorts: TESTING_COHORTS ? TESTING_COHORTS.split(',') : [],
    currency: {
      url: BAT_RATIOS_URL,
      access_token: BAT_RATIOS_TOKEN
    },
    referrals: {
      currency: REFERRALS_CURRENCY || 'USD',
      amount: REFERRALS_AMOUNT || 5
    },
    postgres: service === 'eyeshade' ? { url: BAT_POSTGRES_URL } : false,
    redeemer: {
      url: REDEEMER_URL || 'http://127.0.0.1:3333',
      access_token: REDEEMER_TOKEN || '00000000-0000-4000-0000-000000000000'
    },
    captcha: {
      url: CAPTCHA_URL || 'http://127.0.0.1:3334',
      access_token: CAPTCHA_TOKEN || '00000000-0000-4000-0000-000000000000',
      bypass: CAPTCHA_BYPASS_TOKEN || '00000000-0000-4000-0000-000000000000'
    },
    wallet: {
      uphold: {
        accessToken: UPHOLD_ACCESS_TOKEN || 'none',
        clientId: UPHOLD_CLIENT_ID || 'none',
        clientSecret: UPHOLD_CLIENT_SECRET || 'none',
        environment: UPHOLD_ENVIRONMENT || 'sandbox'
      },
      settlementAddress: { BAT: BAT_SETTLEMENT_ADDRESS },
      adsPayoutAddress: { BAT: BAT_ADS_PAYOUT_ADDRESS }
    },
    server: {},
    sentry: {
      dsn: SENTRY_DSN || false,
      slug: HEROKU_SLUG_COMMIT || 'test',
      project: HEROKU_APP_NAME || service
    },
    prometheus: {
      label: SERVICE + '.' + (DYNO || 'web.1'),
      redis: BAT_REDIS_URL || false
    },
    newrelic: {
      key: false
    },
    ledger: {
      url: BAT_LEDGER_SERVER
    },
    login: {
      github: false
    },
    database: {
      mongo: BAT_MONGODB_URI + service
    },
    cache: {
      redis: {
        url: BAT_REDIS_URL
      }
    },
    // all queues go to eyeshade
    queue: {
      rsmq: BAT_EYESHADE_REDIS_URL
    }
  }, extension)
  return new Runtime(config)
}

async function generateServers () {
  const serverLedger = await ledgerServer(3001, ledgerRuntime)
  const serverEyeshade = await eyeshadeServer(3002, eyeshadeRuntime)
  const serverBalance = await balanceServer(3003, balanceRuntime)
  await serverLedger.started
  await serverEyeshade.started
  await serverBalance.started
  const agentLedger = agent(serverLedger.listener).set(AUTH_KEY, token)
  const agentEyeshade = agent(serverEyeshade.listener).set(AUTH_KEY, token)
  const agentBalance = agent(serverBalance.listener).set(AUTH_KEY, token)
  return {
    ledger: {
      app: ledgerApp,
      runtime: ledgerRuntime,
      server: serverLedger,
      agent: agentLedger
    },
    eyeshade: {
      app: eyeshadeApp,
      runtime: eyeshadeRuntime,
      server: serverEyeshade,
      agent: agentEyeshade
    },
    balance: {
      app: balanceApp,
      runtime: balanceRuntime,
      server: serverBalance,
      agent: agentBalance
    }
  }
}

async function serverContext (t) {
  const servers = await setupServers()
  Object.assign(t.context, servers)
}

async function setupServers () {
  completedSetupServers = completedSetupServers || await generateServers()
  return completedSetupServers
}
