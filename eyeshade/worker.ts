import dotenv from 'dotenv'
import utils from 'bat-utils'
import config from '../config'
import publishersWorker from './workers/publishers'
import referralsWorker from './workers/referrals'
import reportsWorker from './workers/reports'
import surveyorsWorker from './workers/surveyors'
import walletWorker from './workers/wallet'
import adsWorker from './workers/ads'
import currentMigrations from './migrations/current'

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

config.cache = null
config.postgres.schemaVersion = currentMigrations

extras.worker(options, Runtime(config))
