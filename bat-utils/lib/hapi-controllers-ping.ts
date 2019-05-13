import Joi from 'joi'
import underscore from 'underscore'

import braveHapi from './extras-hapi'
import npminfo from '../npminfo'

/*
   GET /v1/ping
 */

const v1Ping = {
  handler: (runtime) => {
    return async (request, reply) => {
      reply(underscore.omit(npminfo, [ 'dependencies' ]))
    }
  },

  auth: {
    strategy: 'session',
    scope: [ 'devops' ],
    mode: 'required'
  },

  description: 'Returns information about the server',
  tags: [ 'api' ],

  validate:
    { query: {} },

  response:
    { schema: Joi.object().keys().unknown(true).description('static properties of the server') }
}

const v1 = {
  ping: v1Ping
}

const routes = [ braveHapi.routes.async().path('/v1/ping').config(v1.ping) ]

export default {
  routes
}
