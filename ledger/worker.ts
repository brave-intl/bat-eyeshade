import dotenv from 'dotenv'
import utils from 'bat-utils'

import config from '../config'

import * as surveyorWorker from './workers/surveyor'

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

config.cache = null

extras.worker(options, Runtime(config))
