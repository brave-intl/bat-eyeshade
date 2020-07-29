const dns = require('dns')
const os = require('os')
const _ = require('lodash')
const SDebug = require('sdebug')
const underscore = require('underscore')

const npminfo = require('../npminfo')

const Worker = async (options, runtime) => {
  const debug = new SDebug('worker')

  if (!runtime) {
    runtime = options
    options = {}
  }
  underscore.defaults(options, { id: 1 })

  debug.initialize({ worker: { id: options.id } })

  if (process.env.NODE_ENV !== 'production') {
    process.on('warning', (warning) => {
      if (warning.name === 'DeprecationWarning') return

      debug('warning', underscore.pick(warning, ['name', 'message', 'stack']))
    })
  }

  const entries = {}
  const listeners = {}
  let errP
  const resolvers = underscore.uniq(['8.8.8.8', '8.8.4.4'].concat(dns.getServers()))

  const router = async (module) => {
    let {
      workers,
      name
    } = module

    const register = async (queue) => {
      if (entries[queue]) return debug('duplicate worker ' + queue)

      entries[queue] = true

      await runtime.queue.create(queue)
      runtime.queue.listen(queue, (err, debug, payload) => {
        if (err) {
          runtime.captureException(err)
          return debug(queue + ' listen', err)
        }

        runtime.newrelic.startBackgroundTransaction(name, () => {
          const transaction = runtime.newrelic.getTransaction()

          setTimeout(async () => {
            try { await workers[queue](debug, runtime, payload) } catch (ex) {
              debug(queue, { payload: payload, err: ex, stack: ex.stack })
              runtime.newrelic.noticeError(ex, payload)
            }
            transaction.end()
          }, 100)
        })
      })

      listeners[name].push(queue)
    }

    if (typeof module.initialize === 'function') {
      workers = (await module.initialize(debug, runtime)) || workers
    }
    workers = underscore.mapObject(workers, instrumentWorker(runtime))

    listeners[name] = []

    const keys = underscore.keys(workers)
    for (let i = 0; i < keys.length; i += 1) {
      await register(keys[i])
    }
  }

  for (let i = 0; i < options.parentModules.length; i += 1) {
    const mod = options.parentModules[i]
    try {
      await router(mod)
    } catch (ex) {
      errP = true
      debug('error loading workers for ' + mod.name + ': ' + ex.toString())
      console.log(ex.stack)
    }
  }

  if (errP) process.exit(1)

  underscore.keys(listeners).sort().forEach((listener) => { debug(listener, listeners[listener].sort()) })

  dns.setServers(resolvers)
  debug('workers started',
    {
      resolvers: resolvers,
      env: underscore.pick(process.env, ['DEBUG', 'DYNO', 'NEW_RELIC_APP_NAME', 'NODE_ENV', 'BATUTIL_SPACES'])
    })
  runtime.notify(debug, {
    text: os.hostname() + ' ' + npminfo.name + '@' + npminfo.version + ' started ' +
      (process.env.DYNO || 'worker') + '/' + options.id
  })
}

module.exports = Worker

function instrumentWorker (runtime) {
  return (handler, key) => {
    const { prometheus } = runtime
    const { client, register } = prometheus
    const name = `${_.camelCase(key)}_worker_buckets_milliseconds`
    const help = `${key} worker duration buckets in milliseconds`
    const labelNames = ['erred']
    const buckets = prometheus.exponentialBuckets()
    const workerBucketsMilliseconds = new client.Histogram({
      name,
      help,
      labelNames,
      buckets
    })
    register.registerMetric(workerBucketsMilliseconds)

    return async (debug, runtime, payload) => {
      let erred = false
      const end = prometheus.timedRequest(name)
      try {
        await handler(debug, runtime, payload)
      } catch (e) {
        erred = true
        throw e
      } finally {
        end({
          erred
        })
      }
    }
  }
}
