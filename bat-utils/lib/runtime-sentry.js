const { URL } = require('url')
const Raven = require('@sentry/node')
const SDebug = require('sdebug')
const underscore = require('underscore')
const {
  NODE_ENV
} = require('../../env')

const debug = new SDebug('sentry')

module.exports = Sentry

function Sentry (config, runtime) {
  if (!(this instanceof Sentry)) {
    return new Sentry(config, runtime)
  }

  const { sentry } = config
  const {
    dsn,
    project,
    slug
  } = sentry

  if (!dsn) {
    process.on('unhandledRejection', captureException)
    process.on('uncaughtException', captureException)
  }

  const release = `${project}:${slug}`
  const enabled = !!dsn
  debug('sentry release', release)
  Raven.init({
    dsn,
    enabled,
    release,
    captureUnhandledRejections: true
  })

  runtime.captureException = captureException

  if (!config.sentry && NODE_ENV === 'production') {
    throw new Error('config.sentry undefined')
  }

  function captureException (ex, optional) {
    if (optional && optional.req) {
      const request = optional.req
      optional.req = { // If present rewrite the request into sentry format
        method: request.method,
        query_string: request.query,
        headers: underscore.omit(request.headers, [ 'authorization', 'cookie' ])
      }
      try {
        const url = new URL(request.path, runtime.config.server)
        if (url) optional.req['url'] = url
      } catch (ex) {}
      optional.extra = underscore.extend(optional.extra, { timestamp: request.info.received, id: request.id })
    }
    Raven.captureException(ex, optional)
  }
}
