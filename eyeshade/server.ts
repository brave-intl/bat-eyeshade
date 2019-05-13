import dotenv from 'dotenv'
import utils from 'bat-utils'
import config from '../config'
import accountsController from './controllers/accounts'
import ownersController from './controllers/owners'
import publishersController from './controllers/publishers'
import referralsController from './controllers/referrals'
import currentMigrations from './migrations/current'
dotenv.config()
if (!process.env.BATUTIL_SPACES) {
  process.env.BATUTIL_SPACES = '*,-extras.worker'
}
const { Runtime, hapi } = utils
const { controllers, server } = hapi

Runtime.newrelic.setupNewrelic(config, __filename)

const parentModules = [
  accountsController,
  ownersController,
  publishersController,
  referralsController
]

const options = {
  parentModules,
  routes: controllers.index,
  controllers: controllers,
  module: module,
  headersP: false,
  remoteP: true
}

config.cache = null
config.postgres.schemaVersion = currentMigrations

export default server(options, new Runtime(config))
