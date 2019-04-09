const dns = require('dns')
const os = require('os')
const _ = require('underscore')
const asyncHandler = require('hapi-async-handler')
const authBearerToken = require('hapi-auth-bearer-token')
const authCookie = require('hapi-auth-cookie')
const cryptiles = require('cryptiles')
const bell = require('bell')
const boom = require('boom')
const epimetheus = require('epimetheus')
const hapi = require('hapi')
const inert = require('inert')
const Netmask = require('netmask').Netmask
const rateLimiter = require('hapi-rate-limiter')
const SDebug = require('sdebug')
const swagger = require('hapi-swagger')
const underscore = require('underscore')
const vision = require('vision')

const braveHapi = require('./extras-hapi')
const whitelist = require('./hapi-auth-whitelist')

const npminfo = require('../npminfo')
const env = require('../../env')
const {
  ACME_CHALLENGE,
  DYNO,
  IP_GRAYLIST,
  NODE_ENV,
  PORT,
  TOKEN_LIST
} = env
const pushScopedTokens = pushTokens({
  // env var       // scope key
  ALLOWED_ADS_TOKENS: 'ads',
  ALLOWED_PUBLISHERS_TOKENS: 'publishers'
})

function pushTokens (map) {
  const keys = _.keys(map)
  return (token, memo = []) => {
    return keys.reduce((memo, key) => {
      const value = map[key]
      const envTokens = env[key]
      const TOKENS = envTokens ? envTokens.split(',') : []
      const has = braveHapi.isSimpleTokenValid(TOKENS, token)
      return memo.concat(has ? [value] : [])
    }, memo)
  }
}

const Server = async (options, runtime) => {
  const debug = new SDebug('web')

  const graylist = { addresses: IP_GRAYLIST && IP_GRAYLIST.split(',') }
  const server = new hapi.Server()

  server.connection({ port: PORT })

  if (!runtime) {
    runtime = options
    options = {}
  }
  underscore.defaults(options, { id: server.info.id, module: module, headersP: true, remoteP: true })
  if (!options.routes) options.routes = require('./controllers/index')

  debug.initialize({ web: { id: options.id } })

  if (NODE_ENV !== 'production') {
    process.on('warning', (warning) => {
      if (warning.name === 'DeprecationWarning') return

      debug('warning', underscore.pick(warning, [ 'name', 'message', 'stack' ]))
    })
  }

  if (graylist.addresses) {
    graylist.authorizedAddrs = []
    graylist.authorizedBlocks = []

    graylist.addresses.forEach((entry) => {
      if ((entry.indexOf('/') === -1) && (entry.split('.').length === 4)) return graylist.authorizedAddrs.push(entry)

      graylist.authorizedBlocks.push(new Netmask(entry))
    })
  }

  if (runtime.config.prometheus) {
    await new Promise((resolve, reject) => {
      server.register(runtime.prometheus.plugin(), (err) => {
        if (err) {
          reject(err)
          throw err
        } else {
          resolve()
        }
      })
    })
  } else epimetheus.instrument(server)

  await new Promise((resolve, reject) => {
    server.register([
      bell,
      asyncHandler,
      authBearerToken,
      authCookie,
      whitelist,
      inert,
      vision,
      {
        register: rateLimiter,
        options: {
          defaultRate: (request) => {
/*  access type            requests/minute per IP address
    -------------------    ------------------------------
    anonymous (browser)       60
    administrator (github)  3000
    server (bearer token)  60000
 */
            const ipaddr = whitelist.ipaddr(request)
            let authorization, parts, token, tokenlist
            let limit = 60
            if (ipaddr === '127.0.0.1') return { limit: Number.MAX_SAFE_INTEGER, window: 1 }

            if ((graylist.authorizedAddrs) &&
                ((graylist.authorizedAddrs.indexOf(ipaddr) !== -1) ||
                 (underscore.find(graylist.authorizedBlocks, (block) => { return block.contains(ipaddr) })))) {
              return { limit: Number.MAX_SAFE_INTEGER, window: 1 }
            }

            if (whitelist.authorizedP(ipaddr)) {
              authorization = request.raw.req.headers.authorization
              if (authorization) {
                parts = authorization.split(/\s+/)
                token = (parts[0].toLowerCase() === 'bearer') && parts[1]
              } else {
                token = request.query.access_token
              }
              tokenlist = TOKEN_LIST ? TOKEN_LIST.split(',') : []
              limit = (typeof token === 'string' && braveHapi.isSimpleTokenValid(tokenlist, token)) ? 60000 : 3000
            }

            return { limit: limit, window: 60 }
          },
          enabled: true,
          methods: [ 'get', 'post', 'delete', 'put', 'patch' ],
          overLimitError: (rate) => boom.tooManyRequests(`try again in ${rate.window} seconds`),
          rateLimitKey: (request) => whitelist.ipaddr(request) + ':' + runtime.config.server.host,
          redisClient: (runtime.cache && runtime.cache.cache) || runtime.queue.config.client
        }
      },
      {
        register: swagger,
        options: {
          auth: {
            strategy: 'whitelist',
            mode: 'required'
          },
          info: {
            title: npminfo.name,
            version: npminfo.version,
            description: npminfo.description
          }
        }
      }
    ], async (err) => {
      if (err) {
        debug('unable to register extensions', err)
        reject(err)
        throw err
      }

      if (process.env.NODE_ENV === 'production') {
        await new Promise((resolve, reject) => {
          server.register({ register: require('hapi-require-https'), options: { proxy: true } }, (err) => {
            if (err) {
              debug('unable to register hapi-require-https', err)
              reject(err)
              throw err
            } else {
              resolve()
            }
          })
        })
      }

      debug('extensions registered')

      if (runtime.login) {
        if (runtime.login.github) {
          server.auth.strategy('github', 'bell', {
            provider: 'github',
            password: cryptiles.randomString(64),
            clientId: runtime.login.github.clientId,
            clientSecret: runtime.login.github.clientSecret,
            isSecure: runtime.login.github.isSecure,
            forceHttps: runtime.login.github.isSecure,
            scope: ['user:email', 'read:org']
          })

          debug('github authentication: forceHttps=' + runtime.login.github.isSecure)

          server.auth.strategy('session', 'cookie', {
            password: runtime.login.github.ironKey,
            cookie: 'sid',
            isSecure: runtime.login.github.isSecure
          })
          debug('session authentication strategy via cookie')
        } else {
          debug('github authentication disabled')
          if (process.env.NODE_ENV === 'production') {
            throw new Error('github authentication was not enabled yet we are in production mode')
          }

          const bearerAccessTokenConfig = {
            allowQueryToken: true,
            allowMultipleHeaders: false,
            validateFunc: (token, callback) => {
              const tokenlist = process.env.TOKEN_LIST ? process.env.TOKEN_LIST.split(',') : []
              callback(null, (typeof token === 'string' && braveHapi.isSimpleTokenValid(tokenlist, token)), { token: token, scope: ['devops', 'ledger', 'QA'] }, null)
            }
          }

          server.auth.strategy('session', 'bearer-access-token', bearerAccessTokenConfig)
          server.auth.strategy('github', 'bearer-access-token', bearerAccessTokenConfig)

          debug('session authentication strategy via bearer-access-token')
          debug('github authentication strategy via bearer-access-token')
        }
      }

      server.auth.strategy('simple-scoped-token', 'bearer-access-token', {
        allowQueryToken: true,
        allowMultipleHeaders: false,
        validateFunc: (token, callback) => {
          const scope = pushScopedTokens(token)
          const valid = !!scope.length
          callback(null, valid, {
            token,
            scope
          }, null)
        }
      })

      server.auth.strategy('simple', 'bearer-access-token', {
        allowQueryToken: true,
        allowMultipleHeaders: false,
        validateFunc: (token, callback) => {
          const tokenlist = process.env.TOKEN_LIST ? process.env.TOKEN_LIST.split(',') : []
          callback(null, braveHapi.isSimpleTokenValid(tokenlist, token), { token: token }, null)
        }
      })
      resolve()
    })
  })

  server.ext('onRequest', (request, reply) => {
    const headers = options.headersP &&
          underscore.omit(request.headers, (value, key, object) => {
            if ([ 'authorization', 'cookie' ].indexOf(key) !== -1) return true
            return /^x-forwarded-/i.test(key)
          })
    const query = underscore.omit(request.url.query, (value, key, object) => {
      return ([ 'publisher' ].indexOf(key) !== -1)
    })
    const remote = options.remoteP &&
          { address: whitelist.ipaddr(request), port: request.headers['x-forwarded-port'] || request.info.remotePort }

    if (request.headers['x-request-id']) request.id = request.headers['x-request-id']
    debug('begin', {
      sdebug: {
        request: {
          id: request.id,
          method: request.method.toUpperCase(),
          pathname: request.url.pathname
        },
        query: query,
        params: request.url.params,
        headers: headers,
        remote: remote
      }
    })

    return reply.continue()
  })

  server.ext('onPreResponse', (request, reply) => {
    const response = request.response

    if (response.isBoom && response.output.statusCode >= 500) {
      const error = response

      runtime.captureException(error, { req: request })
      if (NODE_ENV === 'development') {
        error.output.payload.message = error.message
        if (error.body) {
          error.output.payload.body = error.body
        }
        error.output.payload.stack = error.stack

        return reply(error)
      }
    }

    if ((!response.isBoom) || (response.output.statusCode !== 401)) {
      if (typeof response.header === 'function') response.header('Cache-Control', 'private')
      return reply.continue()
    }

    if (request && request.auth && request.cookieAuth && request.cookieAuth.clear) {
      request.cookieAuth.clear()
      reply.redirect('/v1/login')
    }

    return reply.continue()
  })

  server.on('log', (event, tags) => {
    debug(event.data, { tags: tags })
  }).on('request', (request, event, tags) => {
    debug(event.data, { tags: tags }, { sdebug: { request: { id: event.request, internal: event.internal } } })
  }).on('request-internal', (request, event, tags) => {
    let params

    if ((!tags) || (!tags.received)) return

    params = {
      request: {
        id: request.id,
        method: request.method.toUpperCase(),
        pathname: request.url.pathname
      },
      tags: tags
    }

    debug('begin', { sdebug: params })
  }).on('response', (request) => {
    if (!request.response) request.response = {}
    const flattened = {}
    const logger = request._logger || []
    const params = {
      request: {
        id: request.id,
        method: request.method.toUpperCase(),
        pathname: request.url.pathname,
        statusCode: request.response.statusCode
      },
      headers: request.response.headers,
      error: braveHapi.error.inspect(request.response._error)
    }

    if ((request.response.statusCode === 401) || (request.response.statusCode === 406)) {
      runtime.captureException(request.response._error || request.response.statusCode, {
        req: request,
        extra: { address: whitelist.ipaddr(request) }
      })
    }

    logger.forEach((entry) => {
      if ((entry.data) && (typeof entry.data.msec === 'number')) { params.request.duration = entry.data.msec }
    })

    if ((runtime.newrelic) && (request.response._error)) {
      underscore.keys(params).forEach(param => {
        underscore.keys(params[param]).forEach(key => {
          if ((param === 'error') && ((key === 'message') || (key === 'payload') || (key === 'stack'))) return

          flattened[param + '.' + key] = params[param][key]
        })
      })
      flattened.url = flattened['request.pathname']
      delete flattened['request.pathname']
      runtime.newrelic.noticeError(request.response._error, flattened)
    }

    debug('end', { sdebug: params })
  })

  server.route(await options.routes.routes(debug, runtime, options))
  server.route({ method: 'GET', path: '/favicon.ico', handler: { file: './documentation/favicon.ico' } })
  server.route({ method: 'GET', path: '/favicon.png', handler: { file: './documentation/favicon.png' } })
  server.route({ method: 'GET', path: '/robots.txt', handler: { file: './documentation/robots.txt' } })
  if (ACME_CHALLENGE) {
    server.route({
      method: 'GET',
      path: '/.well-known/acme-challenge/' + ACME_CHALLENGE.split('.')[0],
      handler: (request, reply) => { reply(ACME_CHALLENGE) }
    })
  }
  // automated fishing expeditions shouldn't result in devops alerts...
  server.route({ method: 'GET', path: '/{path*}', handler: { file: './documentation/robots.txt' } })

  server.started = new Promise((resolve, reject) => {
    server.start((err) => {
      if (err) {
        debug('unable to start server', err)
        reject(err)
        throw err
      }

      let resolvers = underscore.uniq([ '8.8.8.8', '8.8.4.4' ].concat(dns.getServers()))

      dns.setServers(resolvers)
      debug('webserver started',
        underscore.extend(
          { server: runtime.config.server.href, version: server.version, resolvers: resolvers },
          server.info,
          {
            env: underscore.pick(env, [ 'DEBUG', 'DYNO', 'NEW_RELIC_APP_NAME', 'NODE_ENV', 'BATUTIL_SPACES' ]),
            options: underscore.pick(options, [ 'headersP', 'remoteP' ])
          }))
      runtime.notify(debug, {
        text: os.hostname() + ' ' + npminfo.name + '@' + npminfo.version + ' started ' +
          (DYNO || 'web') + '/' + options.id
      })

      resolve('started')
      // Hook to notify start script.
      if (process.send) { process.send('started') }
    })
  })

  return server
}

module.exports = Server
