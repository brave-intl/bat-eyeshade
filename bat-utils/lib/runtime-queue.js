const BeeQueue = require('bee-queue')
const redis = require('redis')
const SDebug = require('sdebug')
const debug = new SDebug('queue')

module.exports = Queue

const defaultConfig = {
  activateDelayedJobs: true
}

function Queue (config, runtime) {
  const { queue: url } = config
  this.runtime = runtime
  this.debug = debug
  this.created = {}
  this.processes = {}
  this.config = {
    url,
    client: redis.createClient(url)
  }
  process.on('exit', () => this.quit(0))
}

Queue.prototype = {
  connect: function (passed) {
    const { config } = this
    const client = passed || config.client
    config.client = client
    return new Promise((resolve) => {
      client.on('connect', resolve)
    })
  },
  send: function (debug, key, data, options) {
    debug(`sends:${key}:%o`, data)
    const client = this.create(key)
    return send(client, data, options)
  },
  create: function (key) {
    const { created } = this
    return create(created, this.createConfig(), key)
  },
  waitFor,
  register: function (queues, processes) {
    const {
      runtime,
      debug,
      processes: procs
    } = this
    const config = this.createConfig({
      isWorker: true
    })
    return register(debug, runtime, config, queues, processes || procs)
  },
  createConfig: function (passed = {}) {
    const { config } = this
    return Object.assign({}, defaultConfig, {
      redis: config.client
    }, passed)
  },
  quit: async function (timeout = 1000) {
    const { processes, config } = this
    const keys = Object.keys(processes)
    await Promise.all(keys.map((key) => {
      const { queue } = processes[key]
      return queue.close(1000)
    }))
    await config.client.quit()
    this.processes = {}
    this.created = {}
    debug('quit')
  }
}

function waitFor (job, options = {}) {
  const {
    fail = true
  } = options
  return new Promise((resolve, reject) => {
    job.on('succeeded', resolve)
    job.on('error', reject)
    if (fail) {
      job.on('failed', reject)
    }
  })
}

function send (queue, data, options = {}) {
  const {
    retries = 5,
    backoff = {}
  } = options
  const {
    type = 'exponential',
    delay = 2 * 1000 * 60
  } = backoff
  return queue.createJob(data)
    .retries(retries)
    .backoff(type, delay)
    .save()
}

function create (created, config, key) {
  let current = created[key]
  if (!current) {
    current = new BeeQueue(key, config)
    created[key] = current
  }
  return current
}

function register (debug, runtime, config, queues, processes) {
  for (let mod of queues) {
    const { workers } = mod
    if (!workers) {
      continue
    }
    const keys = Object.keys(workers)
    keys.forEach((key) => {
      if (processes[key]) {
        throw new Error('duplicate queue registered')
      }
      debug(`setup-worker:${key}`)
      const method = workers[key]
      const queue = new BeeQueue(key, config)
      processes[key] = {
        method,
        queue
      }
      queue.checkStalledJobs(5000)
      queue.process(async ({
        id,
        data
      }) => {
        debug('start', { key, id, data })
        try {
          const result = await method(debug, runtime, data)
          debug('ended', { key, id })
          return result
        } catch (e) {
          const { message, stack } = e
          debug('error', { key, id, message, stack })
          throw e
        }
      })
    })
  }
  return processes
}
