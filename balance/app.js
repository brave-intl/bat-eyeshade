const { hapi } = require('bat-utils')
const { controllers, server } = hapi

const addressControllers = require('./controllers/address')

const parentModules = [
  addressControllers
]

const defaultOpts = {
  parentModules,
  routes: controllers.index,
  controllers,
  module: module,
  headersP: false,
  remoteP: true
}

module.exports = (options, runtime) => {
  const opts = Object.assign(defaultOpts, options)
  return server(opts, runtime)
}
