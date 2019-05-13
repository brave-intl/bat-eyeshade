import os from 'os'
import boom from 'boom'
import Octokit from '@octokit/rest'
import Joi from 'joi'
import underscore from 'underscore'
import braveHapi from './extras-hapi'
import whitelist from './hapi-auth-whitelist'
import npminfo from '../npminfo'

/*
   GET /v1/login
 */

const v1Login = {
  handler: (runtime) => {
    return async (request, reply) => {
      const { auth } = request
      if (!auth.isAuthenticated) return reply(boom.forbidden())

      const debug = braveHapi.debug(module, request)
      const { credentials } = auth
      const { profile, provider, token, scope } = credentials
      const octokit = new Octokit()

      try {
        octokit.authenticate({
          type: 'token',
          token: token
        })
        const body = await octokit.teams.listForAuthenticatedUser({})
        const scope = body.data.reduce((memo, team) => {
          if (team.organization.login === runtime.login.github.organization) {
            memo.push(team.name)
          }
          return memo
        }, [])
        credentials.scope = scope
        if (scope.length === 0) {
          runtime.notify(debug, {
            channel: '#devops-bot',
            text: 'login failed ' + provider + ' ' + profile.email
          })
          return reply(boom.forbidden())
        }

        const { DYNO } = process.env
        const subProfile = underscore.pick(profile, [ 'username', 'displayName', 'email', 'id' ])
        runtime.notify(debug, {
          channel: '#devops-bot',
          text: `login ${provider} ${JSON.stringify(subProfile)}: ${JSON.stringify(scope)} at ${os.hostname()} ${npminfo.name}@${npminfo.version}${DYNO ? ' at ' + DYNO : ''} from ${whitelist.ipaddr(request)}`
        })

        request.cookieAuth.set(credentials)
        return reply.redirect(runtime.login.github.world)
      } catch (e) {
        return reply('Oops!')
      }
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

const v1Logout = {
  handler: (runtime) => {
    return async (request, reply) => {
      const debug = braveHapi.debug(module, request)
      const credentials = request.auth.credentials
      const suffix = ' at ' + os.hostname() + ' ' + npminfo.name + '@' + npminfo.version +
            (process.env.DYNO ? ' at ' + process.env.DYNO : '') + ' from ' + whitelist.ipaddr(request)

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

const v1 = {
  login: v1Login,
  logout: v1Logout
}

const routes = [
  braveHapi.routes.async().path('/v1/login').whitelist().config(v1.login),
  braveHapi.routes.async().path('/v1/logout').config(v1.logout)
]

export default {
  routes
}
