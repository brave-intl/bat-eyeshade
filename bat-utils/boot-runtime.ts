
import path from 'path'

import SDebug from 'sdebug'
import _ from 'underscore'

import cache from './lib/runtime-cache'
import currency from './lib/runtime-currency'
import database from './lib/runtime-database'
import newrelic from './lib/runtime-newrelic'
import postgres from './lib/runtime-postgres'
import prometheus from './lib/runtime-prometheus'
import queue from './lib/runtime-queue'
import sentry from './lib/runtime-sentry'
import slack from './lib/runtime-slack'
import wallet from './lib/runtime-wallet'

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

export default Object.assign(Runtime, hash)

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

function Runtime (config): void {
  if (!(this instanceof Runtime)) {
    return new Runtime(config)
  }

  if (!config) {
    config = process.env.NODE_ENV || 'development'
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
