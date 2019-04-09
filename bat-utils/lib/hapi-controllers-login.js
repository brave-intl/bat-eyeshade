const os = require('os')

const boom = require('boom')
const GitHub = require('@octokit/rest')
const Joi = require('joi')
const underscore = require('underscore')

const braveHapi = require('./extras-hapi')
const whitelist = require('./hapi-auth-whitelist')

const npminfo = require('../npminfo')
const {
  DYNO
} = require('../../env')
const v1 = {}

/*
   GET /v1/login
 */

v1.login = {
  handler: (runtime) => {
    return async (request, reply) => {
      if (!request.auth.isAuthenticated) return reply(boom.forbidden())

      const debug = braveHapi.debug(module, request)
      const credentials = request.auth.credentials
      const gh = new GitHub({ debug: false })

      gh.authenticate({ type: 'token', token: credentials.token })
      gh.users.getTeams({}, (err, data) => {
        if (err) return reply('Oops!')

        credentials.scope = []
        data.data.forEach(team => {
          if (team.organization.login === runtime.login.github.organization) credentials.scope.push(team.name)
        })
        if (credentials.scope.length === 0) {
          runtime.notify(debug, {
            channel: '#devops-bot',
            text: 'login failed ' + credentials.provider + ' ' + credentials.profile.email
          })
          return reply(boom.forbidden())
        }

        runtime.notify(debug, {
          channel: '#devops-bot',
          text: 'login ' + credentials.provider + ' ' +
            JSON.stringify(underscore.pick(credentials.profile, [ 'username', 'displayName', 'email', 'id' ])) +
            ': ' + JSON.stringify(credentials.scope) + ' at ' + os.hostname() + ' ' + npminfo.name + '@' +
            npminfo.version + (DYNO ? ' at ' + DYNO : '') + ' from ' + whitelist.ipaddr(request)
        })

        request.cookieAuth.set(credentials)
        reply.redirect(runtime.login.github.world)
      })
    }
  },

  auth: 'github',

  description: 'Logs the user into management operations',
  notes: 'This operation authenticates an administrative role for the server. The user is asked to authenticate their GitHub identity, and are assigned permissions based on team-membership. Operations are henceforth authenticated via an encrypted session cookie.',
  tags: [ 'api' ],

  validate: {
    query: {
      code: Joi.string().optional().description('an opaque string identifying an oauth flow'),
      state: Joi.string().optional().description('an opaque string')
    }
  }
}

/*
   GET /v1/logout
 */

v1.logout = {
  handler: (runtime) => {
    return async (request, reply) => {
      const debug = braveHapi.debug(module, request)
      const credentials = request.auth.credentials
      const suffix = ' at ' + os.hostname() + ' ' + npminfo.name + '@' + npminfo.version +
            (DYNO ? ' at ' + DYNO : '') + ' from ' + whitelist.ipaddr(request)

      if (credentials) {
        runtime.notify(debug, {
          channel: '#devops-bot',
          text: 'logout ' + credentials.provider + ' ' +
            JSON.stringify(underscore.pick(credentials.profile, [ 'username', 'displayName', 'email', 'id' ])) +
': ' + JSON.stringify(credentials.scope) + suffix
        })
      } else {
        runtime.notify(debug, {
          channel: '#devops-bot',
          text: 'logout' + suffix
        })
      }

      request.cookieAuth.clear()
      reply.redirect(runtime.login.github.bye)
    }
  },

  description: 'Logs the user out',
  notes: 'Used to remove the authenticating session cookie.',
  tags: [ 'api' ],

  validate:
    { query: {} }
}

module.exports.routes = [
  braveHapi.routes.async().path('/v1/login').whitelist().config(v1.login),
  braveHapi.routes.async().path('/v1/logout').config(v1.logout)
]
