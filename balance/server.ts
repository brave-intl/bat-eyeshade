import dotenv from 'dotenv'
import config from '../config'
import utils from '../bat-utils'
import addressControllers from './controllers/address'

const {
  hapi,
  Runtime
} = utils

dotenv.config()

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

config.database = null
config.queue = null

export default hapiServer(options, new Runtime(config))
