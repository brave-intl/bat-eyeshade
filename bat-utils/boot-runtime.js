const path = require('path')

const SDebug = require('sdebug')
const _ = require('underscore')

const cache = require('./lib/runtime-cache')
const currency = require('./lib/runtime-currency')
const database = require('./lib/runtime-database')
const newrelic = require('./lib/runtime-newrelic')
const postgres = require('./lib/runtime-postgres')
const prometheus = require('./lib/runtime-prometheus')
const queue = require('./lib/runtime-queue')
const sentry = require('./lib/runtime-sentry')
const slack = require('./lib/runtime-slack')
const wallet = require('./lib/runtime-wallet')
const { NODE_ENV } = require('../env')

const hash = {
  cache,
  currency,
  database,
  newrelic,
  postgres,
  prometheus,
  queue,
  sentry,
  slack,
  wallet
}

module.exports = Object.assign(Runtime, hash)

Runtime.prototype = {
  setup: function (config) {
    const debug = new SDebug('boot')
    _.assign(this, {
      config: config,
      login: config.login,
      notify: (dbg, payload) => {
        const debougie = dbg || debug
        if (payload.text) {
          debougie('notify', payload)
        }
      }
    })
    _.keys(hash).reduce(reduction(config), this)
  }
}

function Runtime (config) {
  if (!(this instanceof Runtime)) {
    return new Runtime(config)
  }

  if (!config) {
    config = NODE_ENV || 'development'
  }
  if (typeof config === 'string') {
    config = require(path.join(process.cwd(), 'config', 'config.' + config + '.js'))
  }

  sanity(config)

  this.setup(config)
}

function reduction (config) {
  return (memo, key) => {
    if (!config[key]) {
      return memo
    }
    const Fn = hash[key]
    memo[key] = new Fn(config, memo)
    return memo
  }
}

function sanity (config) {
  _.keys(config).forEach((key) => {
    let m = config[key]
    if (typeof m === 'undefined') {
      return
    }

    _.keys(m).forEach((k) => {
      if (typeof m[k] === 'undefined') {
        throw new Error('config.' + key + '.' + k + ': undefined')
      }

      if ((typeof m[k] !== 'number') && (typeof m[k] !== 'boolean') && (typeof m[k] !== 'object') && (!m[k])) {
        throw new Error('config.' + key + '.' + k + ': empty')
      }
    })
  })
}
