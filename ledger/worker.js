const dotenv = require('dotenv')
const utils = require('bat-utils')

const config = require('../config.js')

const publisherWorker = require('./workers/publisher')
const rulesetsWorker = require('./workers/rulesets')
const surveyorWorker = require('./workers/surveyor')

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
  publisherWorker,
  rulesetsWorker,
  surveyorWorker
]

const options = {
  parentModules,
  module: module
}

config.cache = false

extras.worker(options, new Runtime(config))
