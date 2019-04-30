const { hapi } = require('bat-utils')
const { controllers, server } = hapi

const grantsController = require('./controllers/grants')
const registrarController = require('./controllers/registrar')
const surveyorController = require('./controllers/surveyor')
const walletController = require('./controllers/wallet')

const parentModules = [
  grantsController,
  registrarController,
  surveyorController,
  walletController
]

const defaultOpts = {
  parentModules,
  routes: controllers.index,
  controllers: controllers,
  module: module,
  headersP: false,
  remoteP: false
}

module.exports = (options, runtime) => {
  const opts = Object.assign(defaultOpts, options)
  return server(opts, runtime)
}
