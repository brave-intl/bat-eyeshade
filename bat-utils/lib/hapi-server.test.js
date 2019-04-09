'use strict'

import Server from './hapi-server'
import Cache from './runtime-cache'
import test from 'ava'
import supertest from 'supertest'
import {
  BAT_REDIS_URL
} from '../../env'

test('hapi throws', async (t) => {
  const message = 'failed in throwing test'

  const runtime = {
    config: {server: {}},
    notify: () => {},
    captureException: (err, extra) => {
      t.is(err.message, message)
    },
    cache: new Cache({
      cache: {
        redis: {
          url: BAT_REDIS_URL || 'redis://localhost:6379'
        }
      }
    })
  }

  const server = await Server({
    id: 'a',
    routes: {
      routes: async () => {
        return {
          method: 'GET',
          path: '/throwing-test',
          handler: async (request, reply) => {
            throw new Error(message)
          }
        }
      }
    }
  }, runtime)

  await server.started

  await supertest(server.listener).get('/throwing-test').send().expect(500)

  await server.stop({
    timeout: 1
  })
})
