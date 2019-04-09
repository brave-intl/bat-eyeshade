const dotenv = require('dotenv')
const utils = require('bat-utils')

const config = require('../config.js')

const publishersWorker = require('./workers/publishers')
const reportsWorker = require('./workers/reports')
const surveyorsWorker = require('./workers/surveyors')
const walletWorker = require('./workers/wallet')

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
  reportsWorker,
  surveyorsWorker,
  walletWorker
]

const options = {
  parentModules,
  module: module
}

config.cache = false
config.postgres.schemaVersion = require('./migrations/current')

extras.worker(options, new Runtime(config))
