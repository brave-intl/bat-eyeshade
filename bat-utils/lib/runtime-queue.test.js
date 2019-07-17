'use strict'
import {
  serial as test
} from 'ava'
import redis from 'redis'
import Queue from './runtime-queue'
import SDebug from 'sdebug'
import uuidV4 from 'uuid/v4'
import _ from 'underscore'
import {
  timeout
} from './extras-utils'
const debug = new SDebug('runtime-queue-test')
const { BAT_REDIS_URL } = process.env
const fakeRuntime = {
  id: 'fake'
}

const queueClient = new Queue({
  queue: BAT_REDIS_URL
}, fakeRuntime)
const queueWorker = new Queue({
  queue: BAT_REDIS_URL
}, fakeRuntime)

test('queues can be instantiated', (t) => {
  t.true(queueClient instanceof Queue, 'an instance is returned')
  t.true(queueWorker instanceof Queue, 'an instance is returned')
})

test('a message can be sent', async (t) => {
  let value = 0
  const key = uuidV4()
  queueWorker.register([{
    workers: {
      [key]: async () => {
        value += 1
      }
    }
  }])
  await queueClient.create(key)
  const job = await queueClient.send(debug, key)
  await queueClient.waitFor(job)
  t.is(value, 1, 'worker runs')
})

test('a delay can be imposed', async (t) => {
  let value = 0
  const key = uuidV4()
  queueWorker.register([{
    workers: {
      [key]: async () => {
        value += 1
        if (value <= 3) {
          debug('too soon', value)
          throw new Error('too soon')
        }
        debug('just right', value)
        return value
      }
    }
  }])
  await queueClient.create(key)
  const start = new Date()
  const job = await queueClient.send(debug, key, null, {
    retries: 4,
    backoff: {
      delay: 200
    }
  })
  const waiting = queueClient.waitFor(job, {
    fail: false
  })
  const finished = await Promise.race([
    waiting, // should be ~1400ms
    timeout(1800).then(() => 1)
  ])
  const diff = (new Date()) - start
  t.true(diff > 1399, 'exponential at 200ms + 400ms + 800ms')
  t.is(finished, 4, 'the correct value was realized')
})

test('nothing happens if workers are missing', async (t) => {
  t.plan(0)
  queueWorker.register([{
    workers: null
  }])
})

test('will err if multiple workers are registered', async (t) => {
  const id = uuidV4()
  const workers = {
    [id]: () => {}
  }
  queueWorker.register([{ workers }])
  t.throws(() => queueWorker.register([{ workers }]))
})

test('passes through debug, runtime, and payload', async (t) => {
  t.plan(3)
  const key = uuidV4()
  const originalPayload = {
    unique: true
  }
  const workers = {
    [key]: (debug, runtime, payload) => {
      t.deepEqual(payload, originalPayload, 'payload is passed as is')
      t.true(_.isFunction(debug), 'debug function is passed')
      t.is(fakeRuntime, runtime, 'runtime from the queue is passed')
    }
  }
  queueWorker.register([{ workers }])
  const job = await queueClient.send(debug, key, originalPayload)
  await queueClient.waitFor(job)
})

test('jobs wait for their workers', async (t) => {
  t.plan(1)
  const key = uuidV4()
  const workers = {
    [key]: () => {
      t.true(true, 'it ran')
    }
  }
  await queueClient.create(key)
  const job = await queueClient.send(debug, key)
  await timeout(1000)
  queueWorker.register([{ workers }])
  await queueClient.waitFor(job)
})

test('jobs wait for their workers even if they are disconnected', async (t) => {
  t.plan(1)
  const key = uuidV4()
  let after = false
  let complete = false
  const workers = {
    [key]: () => {
      complete = true
      t.true(after, 'it ran after being disconnected')
    }
  }

  queueWorker.register([{ workers }])
  await queueClient.create(key)
  await queueClient.send(debug, key, null, {
    backoff: {
      delay: 20
    }
  })
  await queueWorker.quit()
  await queueWorker.connect(redis.createClient(BAT_REDIS_URL))
  after = true
  queueWorker.register([{ workers }])
  while (!complete) { // eslint-disable-line
    await timeout(1000)
  }
})

test('can disconnect', async (t) => {
  t.plan(0)
  await queueClient.quit()
  await queueWorker.quit()
})
