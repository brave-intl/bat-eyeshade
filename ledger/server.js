require('dotenv').config()
if (!process.env.BATUTIL_SPACES) {
  process.env.BATUTIL_SPACES = '*,-extras.worker'
}
const { Runtime } = require('bat-utils')

const config = require('../config.js')

Runtime.newrelic.setupNewrelic(config, __filename)

const app = require('./app')
const options = {
  port: process.env.PORT
}

config.cache = false

const runtime = new Runtime(config)
module.exports = app(options, runtime)
