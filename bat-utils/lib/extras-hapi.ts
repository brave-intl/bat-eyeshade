import crypto from 'crypto'
import ProxyAgent from 'proxy-agent'
import SDebug from 'sdebug'
import underscore from 'underscore'
import wreck from 'wreck'

import npminfo from '../npminfo'
import whitelist from './hapi-auth-whitelist'

const debug = (info, request) => {
  const debug = new SDebug(info.id)

  debug.initialize({ request: { id: request.id } })
  return debug
}

const domainCompare = (a, b) => {
  let d

  if (!a) a = ''
  a = a.split('.').reverse()
  if (!b) b = ''
  b = b.split('.').reverse()

  while (true) {
    if (a.length === 0) {
      return (b.length === 0 ? 0 : (-1))
    } else if (b.length === 0) return 1

    d = a.shift().localeCompare(b.shift())
    if (d !== 0) return (d < 0 ? (-1) : 1)
  }
}

const constantTimeEquals = (a, b) => {
  let mismatch = a.length !== b.length
  if (mismatch) {
    b = a
  }
  return !(mismatch || !crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)))
}

const isSimpleTokenValid = (tokenList: string[] | string, token: string[] | string) => {
  if (!(Array.isArray(tokenList) && tokenList.every((element) => typeof element === 'string'))) {
    throw new TypeError('tokenList must be an array of strings')
  }
  if (typeof token !== 'string') {
    throw new TypeError('token must be a string')
  }

  for (let i = 0; i < tokenList.length; i++) {
    if (constantTimeEquals(tokenList[i], token)) {
      return true
    }
  }
  return false
}

AsyncRoute.prototype = {
  get: function () {
    this.internal.method = 'GET'
    return this
  },

  post: function () {
    this.internal.method = 'POST'
    return this
  },

  put: function () {
    this.internal.method = 'PUT'
    return this
  },

  patch: function () {
    this.internal.method = 'PATCH'
    return this
  },

  delete: function () {
    this.internal.method = 'DELETE'
    return this
  },

  path: function (path) {
    this.internal.path = path
    return this
  },

  whitelist: function () {
    this.internal.extras = {
      ext: {
        onPreAuth: {
          method: whitelist.authenticate
        }
      }
    }

    return this
  },

  config: function (config) {
    if (typeof config === 'function') { config = { handler: config } }
    if (typeof config.handler === 'undefined') { throw new Error('undefined handler for ' + JSON.stringify(this.internal)) }

    return (runtime) => {
      const payload = { handler: { async: config.handler(runtime) } }

      underscore.keys(config).forEach(key => {
        if ((key !== 'handler') && (typeof config[key] !== 'undefined')) payload[key] = config[key]
      })

      return {
        method: this.internal.method,
        path: this.internal.path,
        config: underscore.extend(payload, this.internal.extras)
      }
    }
  }
}
function AsyncRoute (): void {
  if (!(this instanceof AsyncRoute)) return new AsyncRoute()

  this.internal = {}
  this.internal.method = 'GET'
  this.internal.path = '/'
  this.internal.extras = {}
}

const routes = { async: () => new AsyncRoute() }

const ErrorInspect = (err) => {
  let i, properties

  if (!err) return

  properties = [ 'message', 'isBoom', 'isServer' ]
  if (!err.isBoom) properties.push('stack')
  i = underscore.pick(err, properties)
  if ((err.output) && (err.output.payload)) { underscore.defaults(i, { payload: err.output.payload }) }

  return i
}

const error = { inspect: ErrorInspect }

let wreckUA = ''
if (npminfo) {
  wreckUA += npminfo.name + '/' + npminfo.version + ' wreck/' + npminfo.dependencies.wreck
}

underscore.keys(process.versions).forEach((version) => { wreckUA += ' ' + version + '/' + process.versions[version] })

const WreckProxy = (server, opts = <any>{}) => {
  let useProxyP

  if (!opts) opts = {}
  if (!opts.headers) opts.headers = {}
  if (!opts.headers['user-agent'] && !opts.headers['User-Agent']) opts.headers['user-agent'] = wreckUA

  underscore.keys(opts.headers).forEach((header) => {
    if (typeof opts.headers[header] !== 'string') delete opts.headers[header]
  })

  if (typeof opts.useProxyP === 'undefined') return { server: server, opts: opts }

  useProxyP = opts.useProxyP
  opts = underscore.omit(opts, [ 'useProxyP' ])
  if ((!useProxyP) || (!process.env.FIXIE_URL)) return { server: server, opts: opts }

  return { server: server, opts: underscore.extend(opts, { agent: new ProxyAgent(process.env.FIXIE_URL) }) }
}

const WreckGet = async (server, opts = <any>{}) => {
  const params = WreckProxy(server, opts)
  const { res, payload } = await wreck.get(params.server, params.opts) // eslint-disable-line no-unused-vars
  return payload
}

const WreckPost = async (server, opts = <any>{}) => {
  const params = WreckProxy(server, opts)
  const { res, payload } = await wreck.post(params.server, params.opts) // eslint-disable-line no-unused-vars
  return payload
}

const WreckPut = async (server, opts = <any>{}) => {
  const params = WreckProxy(server, opts)
  const { res, payload } = await wreck.put(params.server, params.opts) // eslint-disable-line no-unused-vars
  return payload
}

const WreckPatch = async (server, opts = <any>{}) => {
  const params = WreckProxy(server, opts)
  const { res, payload } = await wreck.patch(params.server, params.opts) // eslint-disable-line no-unused-vars
  return payload
}

const WreckDelete = async (server, opts = <any>{}) => {
  const params = WreckProxy(server, opts)
  const { res, payload } = await wreck.delete(params.server, params.opts) // eslint-disable-line no-unused-vars
  return payload
}

const wreckr = { get: WreckGet, patch: WreckPatch, post: WreckPost, put: WreckPut, delete: WreckDelete }

export default {
  debug,
  domainCompare,
  isSimpleTokenValid,
  routes,
  error,
  wreck: wreckr
}
