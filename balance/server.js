const config = require('../config.js')
const utils = require('../bat-utils')

const addressControllers = require('./controllers/address')

const {
  hapi,
  Runtime
} = utils

Runtime.newrelic.setupNewrelic(config, __filename)

const {
  controllers,
  server: hapiServer
} = hapi

const parentModules = [
  addressControllers
]

const options = {
  parentModules,
  routes: controllers.index,
  controllers: controllers,
  module: module
}

config.database = false
config.queue = false

module.exports = hapiServer(options, new Runtime(config))
