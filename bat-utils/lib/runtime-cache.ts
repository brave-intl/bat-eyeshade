import bluebird from 'bluebird'
import redis from 'redis'
import SDebug from 'sdebug'

const debug = new SDebug('cache')
const ONE_HOUR = 1000 * 60 * 60
const MAX_RECONNECT_TIMEOUT = 10000
const MAX_RECONNECT_ATTEMPTS = 100
Cache.accessor = accessor
export default Cache

bluebird.promisifyAll(redis.RedisClient.prototype)
bluebird.promisifyAll(redis.Multi.prototype)

Cache.prototype = {
  accessor,
  quit: function () {
    const { cache } = this
    delete this.cache
    delete this.connectedPromise
    return cache.quit()
  },
  connected: function () {
    let { connectedPromise, cache, options } = this

    if (connectedPromise) {
      return connectedPromise
    }
    cache = redis.createClient(options.url, options)
    this.cache = cache
    connectedPromise = new Promise((resolve, reject) => {
      cache.on('ready', resolve)
      cache.on('error', (err) => {
        debug('redis error', err)
        this.runtime.captureException(err)
        reject(err)
      })
    })
    this.connectedPromise = connectedPromise
    return connectedPromise
  },
  get: async function (key, prefix) {
    const accessor = this.accessor(key, prefix)
    return this.cache.getAsync(accessor)
  },
  set: async function (key, value, options, prefix) {
    const accessor = this.accessor(key, prefix)
    let args = [accessor, value]
    for (let key in options) {
      args = args.concat([key, options[key]])
    }
    return this.cache.setAsync(args)
  },
  del: async function (key, prefix) {
    const accessor = this.accessor(key, prefix)
    return this.cache.delAsync(accessor)
  }
}

function accessor (key, prefix) {
  return prefix ? `${prefix}:${key}` : key
}

function Cache (config, runtime): void {
  if (!(this instanceof Cache)) {
    return new Cache(config, runtime)
  }
  const {
    cache = {}
  } = config
  const { redis } = cache

  if (!redis) {
    return
  }

  this.options = Object.assign({
    retry_strategy: retryStrategy,
    socket_keepalive: true
  }, redis)
  this.connected()
}

function retryStrategy (options) {
  const {
    error,
    total_retry_time: totalRetryTime,
    attempt
  } = options

  if (error && error.code === 'ECONNREFUSED') {
    // End reconnecting on a specific error and flush all commands with
    // a individual error
    return new Error('The server refused the connection')
  } else if (error && error.code === 'NR_CLOSED') {
    // return attempt
  } else if (totalRetryTime > ONE_HOUR) {
    // End reconnecting after a specific timeout and flush all commands
    // with a individual error
    return new Error('Retry time exhausted')
  } else if (attempt > MAX_RECONNECT_ATTEMPTS) {
    // End reconnecting with built in error
    return
  }
  // reconnect after
  return Math.min(attempt * 100, MAX_RECONNECT_TIMEOUT)
}
