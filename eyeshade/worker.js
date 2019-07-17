const dotenv = require('dotenv')
const utils = require('bat-utils')

const config = require('../config.js')

const publishersWorker = require('./workers/publishers')
const referralsWorker = require('./workers/referrals')
const reportsWorker = require('./workers/reports')
const surveyorsWorker = require('./workers/surveyors')
const walletWorker = require('./workers/wallet')
const adsWorker = require('./workers/ads')

const {
  Runtime,
  extras
} = utils

dotenv.config()

if (!process.env.BATUTIL_SPACES) {
  process.env.BATUTIL_SPACES = '*,-hapi'
}

Runtime.newrelic.setupNewrelic(config, __filename)

const parentModules = [
  publishersWorker,
  referralsWorker,
  reportsWorker,
  surveyorsWorker,
  walletWorker,
  adsWorker
]

const options = {
  parentModules,
  module: module
}

config.cache = false
config.postgres.schemaVersion = require('./migrations/current')

const runtime = new Runtime(config)
extras.worker(options, runtime)
runtime.queue.register(parentModules)
