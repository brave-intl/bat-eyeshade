const { hapi } = require('bat-utils')
const { controllers, server } = hapi

const accountsController = require('./controllers/accounts')
const ownersController = require('./controllers/owners')
const publishersController = require('./controllers/publishers')
const referralsController = require('./controllers/referrals')

const parentModules = [
  accountsController,
  ownersController,
  publishersController,
  referralsController
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
