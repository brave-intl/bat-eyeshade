const dotenv = require('dotenv')
const utils = require('bat-utils')

const config = require('../config.js')

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
  surveyorWorker
]

const options = {
  parentModules,
  module: module
}

config.cache = false

const runtime = new Runtime(config)
extras.worker(options, runtime)
runtime.queue.register(parentModules)
