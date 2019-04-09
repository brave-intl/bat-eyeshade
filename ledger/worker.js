const utils = require('bat-utils')

const config = require('../config.js')

const surveyorWorker = require('./workers/surveyor')

const {
  Runtime,
  extras
} = utils

Runtime.newrelic.setupNewrelic(config, __filename)

const parentModules = [
  surveyorWorker
]

const options = {
  parentModules,
  module: module
}

config.cache = false

extras.worker(options, new Runtime(config))
