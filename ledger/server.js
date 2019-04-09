const { Runtime, hapi } = require('bat-utils')
const { controllers, server } = hapi

const grantsController = require('./controllers/grants')
const registrarController = require('./controllers/registrar')
const surveyorController = require('./controllers/surveyor')
const walletController = require('./controllers/wallet')

const config = require('../config.js')

const parentModules = [
  grantsController,
  registrarController,
  surveyorController,
  walletController
]

Runtime.newrelic.setupNewrelic(config, __filename)

const options = {
  parentModules,
  routes: controllers.index,
  controllers: controllers,
  module: module,
  headersP: false,
  remoteP: false
}

config.cache = false

module.exports = server(options, new Runtime(config))
