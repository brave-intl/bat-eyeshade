const { Runtime, hapi } = require('bat-utils')
const { controllers, server } = hapi

const config = require('../config.js')

const accountsController = require('./controllers/accounts')
const ownersController = require('./controllers/owners')
const publishersController = require('./controllers/publishers')
const referralsController = require('./controllers/referrals')

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

config.cache = false
config.postgres.schemaVersion = require('./migrations/current')

module.exports = server(options, new Runtime(config))
