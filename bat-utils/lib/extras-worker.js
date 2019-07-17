const dns = require('dns')
const os = require('os')

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

      debug('warning', underscore.pick(warning, [ 'name', 'message', 'stack' ]))
    })
  }

  const listeners = {}
  let resolvers = underscore.uniq([ '8.8.8.8', '8.8.4.4' ].concat(dns.getServers()))

  underscore.keys(listeners).sort().forEach((listener) => { debug(listener, listeners[listener].sort()) })

  dns.setServers(resolvers)
  debug('workers started',
    {
      resolvers: resolvers,
      env: underscore.pick(process.env, [ 'DEBUG', 'DYNO', 'NEW_RELIC_APP_NAME', 'NODE_ENV', 'BATUTIL_SPACES' ])
    })
  runtime.notify(debug, {
    text: os.hostname() + ' ' + npminfo.name + '@' + npminfo.version + ' started ' +
      (process.env.DYNO || 'worker') + '/' + options.id
  })
}

module.exports = Worker
