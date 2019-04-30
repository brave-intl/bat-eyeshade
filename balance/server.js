const dotenv = require('dotenv')
dotenv.config()
const config = require('../config.js')
const utils = require('../bat-utils')
const { Runtime } = utils

Runtime.newrelic.setupNewrelic(config, __filename)

const app = require('./app')
const options = {
  port: process.env.PORT
}

config.database = false
config.queue = false

const runtime = new Runtime(config)
module.exports = app(options, runtime)
