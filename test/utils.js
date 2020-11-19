const fs = require('fs')
const redis = require('redis')
const { sign } = require('http-request-signature')
const crypto = require('crypto')
const path = require('path')
const dotenv = require('dotenv')
dotenv.config()
const agent = require('supertest').agent
const mongodb = require('mongodb')
const stringify = require('querystring').stringify
const _ = require('underscore')
const uuidV4 = require('uuid/v4')
const pg = require('pg')
const {
  timeout,
  BigNumber,
  uint8tohex
} = require('bat-utils/lib/extras-utils')
const Postgres = require('bat-utils/lib/runtime-postgres')
const SDebug = require('sdebug')
const debug = new SDebug('test')
const Pool = pg.Pool
const Server = require('bat-utils/lib/hapi-server')
const { Runtime } = require('bat-utils')

const {
  TOKEN_LIST,
  BAT_EYESHADE_SERVER,
  BAT_LEDGER_SERVER,
  BAT_BALANCE_SERVER,
  BAT_GRANT_SERVER,
  BAT_REDEEMER_SERVER,
  ALLOWED_REFERRALS_TOKENS,
  ALLOWED_STATS_TOKENS,
  ALLOWED_ADS_TOKENS,
  ALLOWED_PUBLISHERS_TOKENS,
  BAT_MONGODB_URI,
  BAT_REDEEMER_REDIS_URL,
  GRANT_TOKEN,
  REDEEMER_TOKEN,
  BAT_WALLET_MIGRATION_SERVER,
  WALLET_MIGRATION_TOKEN
} = process.env

const braveYoutubeOwner = 'publishers#uuid:' + uuidV4().toLowerCase()
const braveYoutubePublisher = 'youtube#channel:UCFNTTISby1c_H-rm5Ww5rZg'

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

const tkn = 'foobarfoobar'
const token = (tkn) => `Bearer ${tkn}`

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
const GLOBAL_TOKEN = TOKEN_LIST.split(',')[0]
const ledgerGlobalAgent = agent(BAT_LEDGER_SERVER).set(AUTH_KEY, token(GLOBAL_TOKEN))
const ledgerStatsAgent = agent(BAT_LEDGER_SERVER).set(AUTH_KEY, token(ALLOWED_STATS_TOKENS))

const balanceGlobalAgent = agent(BAT_BALANCE_SERVER).set(AUTH_KEY, token(GLOBAL_TOKEN))

const eyeshadeGlobalAgent = agent(BAT_EYESHADE_SERVER).set(AUTH_KEY, token(GLOBAL_TOKEN))
const eyeshadeReferralsAgent = agent(BAT_EYESHADE_SERVER).set(AUTH_KEY, token(ALLOWED_REFERRALS_TOKENS))
const eyeshadeStatsAgent = agent(BAT_EYESHADE_SERVER).set(AUTH_KEY, token(ALLOWED_STATS_TOKENS))
const eyeshadeAdsAgent = agent(BAT_EYESHADE_SERVER).set(AUTH_KEY, token(ALLOWED_ADS_TOKENS))
const eyeshadePublishersAgent = agent(BAT_EYESHADE_SERVER).set(AUTH_KEY, token(ALLOWED_PUBLISHERS_TOKENS))

const grantGlobalAgent = agent(BAT_GRANT_SERVER).set(AUTH_KEY, token(GRANT_TOKEN))

const redeemerGlobalAgent = agent(BAT_REDEEMER_SERVER).set(AUTH_KEY, token(REDEEMER_TOKEN))
const walletMigrationGlobalAgent = agent(BAT_WALLET_MIGRATION_SERVER).set(AUTH_KEY, WALLET_MIGRATION_TOKEN)

const status = (expectation) => (res) => {
  if (!res) {
    return new Error('no response object given')
  }
  const { status, body, request } = res
  if (status !== expectation) {
    const { url, method } = request
    return new Error(JSON.stringify({
      method,
      url,
      expectation,
      status,
      body
    }, null, 2).replace(/\\n/g, '\n'))
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

const dbUri = (db) => `${BAT_MONGODB_URI}/${db}`
const connectToDb = async (key) => {
  const client = await mongodb.MongoClient.connect(dbUri(key), {
    useNewUrlParser: true,
    useUnifiedTopology: true
  })
  return client.db(key)
}

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

const cleanGrantDb = async () => {
  const url = process.env.BAT_GRANT_POSTGRES_URL
  const pool = new Pool({ connectionString: url, ssl: false })
  const client = await pool.connect()
  try {
    await Promise.all([
      client.query('DELETE from claim_creds'),
      client.query('DELETE from claims'),
      client.query('DELETE from wallets'),
      client.query('DELETE from promotions')
    ])
  } finally {
    client.release()
  }
}
const agents = {
  grants: {
    global: grantGlobalAgent
  },
  redeemer: {
    global: redeemerGlobalAgent
  },
  walletMigration: {
    global: walletMigrationGlobalAgent
  },
  eyeshade: {
    global: eyeshadeGlobalAgent,
    referrals: eyeshadeReferralsAgent,
    ads: eyeshadeAdsAgent,
    publishers: eyeshadePublishersAgent,
    stats: eyeshadeStatsAgent
  },
  ledger: {
    global: ledgerGlobalAgent,
    stats: ledgerStatsAgent
  },
  balance: {
    global: balanceGlobalAgent
  }
}

module.exports = {
  transaction: {
    ensureCount: ensureTransactionCount,
    ensureArrived: ensureTransactionArrived
  },
  referral: {
    create: createReferral,
    createLegacy: createLegacyReferral
  },
  settlement: {
    create: createSettlement,
    sendLegacy: sendSettlement,
    createLegacy: createLegacySettlement
  },
  token,
  signTxn,
  cleanRedeemerRedisDb,
  setupForwardingServer,
  agentAutoAuth,
  AUTH_KEY,
  readJSONFile,
  makeSettlement,
  insertReferralInfos,
  getSurveyor,
  fetchReport,
  formURL,
  ok,
  debug,
  status,
  agents,
  assertWithinBounds,
  connectToDb,
  dbUri,
  cleanDb,
  cleanDbs,
  cleanPgDb,
  cleanLedgerDb,
  cleanEyeshadeDb,
  cleanGrantDb,
  braveYoutubeOwner,
  braveYoutubePublisher,
  setupCreatePayload,
  statsUrl
}

function cleanDbs () {
  return Promise.all([
    cleanEyeshadeDb(),
    cleanLedgerDb(),
    cleanGrantDb(),
    cleanEyeshadePgDb(),
    cleanWalletMigrationDb(),
    cleanRedeemerRedisDb()
  ])
}

async function cleanWalletMigrationDb () {
  const url = process.env.BAT_WALLET_MIGRATION_POSTGRES_URL
  const pool = new Pool({ connectionString: url, ssl: false })
  const client = await pool.connect()
  try {
    await Promise.all([
      client.query('DELETE from claim_creds'),
      client.query('DELETE from claims'),
      client.query('DELETE from wallets'),
      client.query('DELETE from promotions')
    ])
  } finally {
    client.release()
  }
}

async function cleanEyeshadePgDb () {
  const postgres = new Postgres({
    postgres: {
      url: process.env.BAT_POSTGRES_URL
    }
  })
  const cleaner = cleanPgDb(postgres)
  return cleaner()
}

function cleanPgDb (postgres) {
  return async () => {
    const client = await postgres.connect()
    try {
      await Promise.all([
        client.query('DELETE from transactions;'),
        client.query('DELETE from surveyor_groups;'),
        client.query('DELETE from geo_referral_countries;'),
        client.query('DELETE from geo_referral_groups;'),
        client.query('DELETE from votes;'),
        client.query('DELETE from balance_snapshots;'),
        client.query('DELETE from payout_reports;')
      ])
      await insertReferralInfos(client)
    } finally {
      client.release()
    }
  }
}

function getSurveyor (id) {
  return ledgerGlobalAgent
    .get(`/v2/surveyor/contribution/${id || 'current'}`)
    .expect(ok)
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
    headers.signature = sign({
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

async function insertReferralInfos (client) {
  const ratesPaths = [{
    path: filePath('0010_geo_referral', 'seeds', 'groups.sql')
  }, {
    path: filePath('0010_geo_referral', 'seeds', 'countries.sql')
  }]
  for (let i = 0; i < ratesPaths.length; i += 1) {
    const { path } = ratesPaths[i]
    await client.query(fs.readFileSync(path).toString())
  }

  function filePath (...paths) {
    return path.join(__dirname, '..', 'eyeshade', 'migrations', ...paths)
  }
}

function readJSONFile (...paths) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, ...paths)).toString())
}

async function setupForwardingServer ({
  routes,
  config,
  initers = [],
  token = uuidV4()
}) {
  const conf = _.extend({
    sentry: {},
    server: {},
    queue: {
      rsmq: process.env.BAT_REDIS_URL
    },
    cache: {
      redis: {
        url: process.env.BAT_REDIS_URL
      }
    },
    captcha: {
      url: process.env.CAPTCHA_URL || 'http://127.0.0.1:3334',
      access_token: process.env.CAPTCHA_TOKEN || '00000000-0000-4000-0000-000000000000',
      bypass: process.env.CAPTCHA_BYPASS_TOKEN || '00000000-0000-4000-0000-000000000000'
    },
    login: {
      github: false
    },
    forward: {
      grants: '1'
    },
    wreck: {
      walletMigration: {
        baseUrl: process.env.BAT_WALLET_MIGRATION_SERVER,
        headers: {
          Authorization: 'Bearer ' + (process.env.WALLET_MIGRATION_TOKEN || '00000000-0000-4000-0000-000000000000'),
          'Content-Type': 'application/json'
        }
      },
      rewards: {
        baseUrl: process.env.BAT_REWARDS_SERVER,
        headers: {
          'Content-Type': 'application/json'
        }
      },
      grants: {
        baseUrl: process.env.BAT_GRANT_SERVER,
        headers: {
          Authorization: 'Bearer ' + (process.env.GRANT_TOKEN || '00000000-0000-4000-0000-000000000000'),
          'Content-Type': 'application/json'
        }
      }
    },
    balance: {
      url: process.env.BAT_BALANCE_URL || 'http://127.0.0.1:3000',
      access_token: process.env.BALANCE_TOKEN || 'foobarfoobar'
    },
    testingCohorts: process.env.TESTING_COHORTS ? process.env.TESTING_COHORTS.split(',') : [],
    prometheus: {
      label: process.env.SERVICE + '.' + (process.env.DYNO || 1)
    },
    disable: {
      grants: false
    },
    database: {
      mongo: process.env.BAT_MONGODB_URI + '/ledger'
    },
    wallet: {
      uphold: {
        accessToken: process.env.UPHOLD_ACCESS_TOKEN || 'none',
        clientId: process.env.UPHOLD_CLIENT_ID || 'none',
        clientSecret: process.env.UPHOLD_CLIENT_SECRET || 'none',
        environment: process.env.UPHOLD_ENVIRONMENT || 'sandbox'
      },
      settlementAddress: {
        BAT: process.env.BAT_SETTLEMENT_ADDRESS || '0x7c31560552170ce96c4a7b018e93cddc19dc61b6'
      }
    },
    currency: {
      url: process.env.BAT_RATIOS_URL,
      access_token: process.env.BAT_RATIOS_TOKEN
    }
  }, config)
  const serverOpts = {
    id: uuidV4(),
    headersP: false,
    remoteP: false,
    routes: {
      routes: (debug, runtime, options) => {
        return _.toArray(routes).map((route) => route(runtime))
      }
    }
  }
  const runtime = new Runtime(conf)
  const server = await Server(serverOpts, runtime)
  await server.started
  const debug = new SDebug('init')
  for (let i = 0; i < initers.length; i += 1) {
    await initers[i](debug, runtime)
  }
  const agent = agentAutoAuth(server.listener, token)
  return {
    server,
    runtime,
    agent
  }
}

function agentAutoAuth (listener, token) {
  return agent(listener).set(AUTH_KEY, `Bearer ${token || tkn}`)
}

async function cleanRedeemerRedisDb () {
  const client = redis.createClient(BAT_REDEEMER_REDIS_URL)
  await new Promise((resolve, reject) => {
    client.on('ready', () => {
      client.flushdb((err) => {
        err ? reject(err) : resolve()
      })
    }).on('error', (err) => reject(err))
  })
}

function signTxn (keypair, body, _octets) {
  let octets = _octets
  if (!octets) {
    octets = JSON.stringify(body)
  }
  const headers = {
    digest: 'SHA-256=' + crypto.createHash('sha256').update(octets).digest('base64')
  }

  headers.signature = sign({
    headers: headers,
    keyId: 'primary',
    secretKey: uint8tohex(keypair.secretKey)
  }, {
    algorithm: 'ed25519'
  })
  return {
    headers,
    octets,
    body
  }
}

function createLegacyReferral (timestamp, groupId) {
  const txId = uuidV4().toLowerCase()
  return {
    txId,
    referral: {
      downloadId: uuidV4().toLowerCase(),
      channelId: braveYoutubePublisher,
      platform: 'ios',
      referralCode: uuidV4().toLowerCase(),
      finalized: timestamp || new Date(),
      groupId,
      downloadTimestamp: timestamp || new Date(),
      ownerId: 'publishers#uuid:' + uuidV4().toLowerCase()
    }
  }
}

function createReferral (options = {}) {
  const originalRateId = '71341fc9-aeab-4766-acf0-d91d3ffb0bfa'
  return Object.assign({
    transactionId: uuidV4(),
    ownerId: 'publishers#uuid:' + uuidV4().toLowerCase(),
    channelId: braveYoutubePublisher,
    finalizedTimestamp: (new Date()).toISOString(),
    downloadId: uuidV4(),
    downloadTimestamp: (new Date()).toISOString(),
    countryGroupId: originalRateId,
    platform: 'desktop',
    referralCode: 'ABC123'
  }, options)
}

async function ensureTransactionCount (t, expect) {
  let rows = []
  do {
    ;({ rows } = await t.context.runtime.postgres.query('select * from transactions'))
  } while (rows.length !== expect && (await timeout(1000) || true))
  return rows
}

async function ensureTransactionArrived (t, id) {
  let seen = []
  do {
    ;({ rows: seen } = await t.context.runtime.postgres.query(`
    select * from transactions where id = $1
    `, [id]))
    console.log('checking for', id)
  } while (seen.length === 0 && (await timeout(1000) || true))
  return seen
}

function createSettlement (options) {
  const amount = new BigNumber(Math.random() + '').times(10)
  const probi = amount.times(1e18)
  return Object.assign({
    settlementId: uuidV4(),
    address: uuidV4(),
    hash: uuidV4(),
    documentId: uuidV4(),
    publisher: braveYoutubePublisher,
    altcurrency: 'BAT',
    currency: 'USD',
    owner: braveYoutubeOwner,
    probi: probi.times(0.95).toFixed(0),
    amount: probi.dividedBy('1e18').toFixed(18),
    commission: '0',
    fee: '0',
    fees: probi.times(0.05).toFixed(0),
    type: 'contribution'
  }, options || {})
}

function createLegacySettlement (options) {
  const amount = new BigNumber(Math.random() + '').times(10)
  const probiTotal = amount.times(1e18)
  const probi = probiTotal.times(0.95)
  const fees = probiTotal.times(0.05)
  return Object.assign({
    altcurrency: 'BAT',
    currency: 'USD',
    address: uuidV4(),
    publisher: braveYoutubePublisher,
    owner: braveYoutubeOwner,
    amount: probi.dividedBy('1e18').toFixed(18),
    probi: probi.toFixed(0),
    fees: fees.toFixed(0),
    fee: (new BigNumber(0)).toString(),
    commission: (new BigNumber(0)).toString(),
    transactionId: uuidV4(),
    type: 'contribution',
    hash: uuidV4()
  }, options || {})
}

async function sendSettlement (
  settlements,
  agent = agents.eyeshade.publishers
) {
  return agent.post('/v2/publishers/settlement')
    .send(settlements)
    .expect(ok)
}
