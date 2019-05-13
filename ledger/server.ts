import dotenv from 'dotenv'
dotenv.config()
if (!process.env.BATUTIL_SPACES) {
  process.env.BATUTIL_SPACES = '*,-extras.worker'
}
import utils from 'bat-utils'
const { Runtime, hapi } = utils
const { controllers, server } = hapi

import grantsController from './controllers/grants'
import registrarController from './controllers/registrar'
import surveyorController from './controllers/surveyor'
import walletController from './controllers/wallet'

import config from '../config'

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

config.cache = null

export default server(options, Runtime(config))
