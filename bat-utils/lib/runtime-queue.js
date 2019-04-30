const bluebird = require('bluebird')
const redis = require('redis')
const Rsmq = require('rsmq')
const RsmqWorker = require('rsmq-worker')
const SDebug = require('sdebug')
const debug = new SDebug('queue')
const underscore = require('underscore')

bluebird.promisifyAll(redis.RedisClient.prototype)
bluebird.promisifyAll(redis.Multi.prototype)

const Queue = function (config, runtime) {
  if (!(this instanceof Queue)) return new Queue(config, runtime)

  if (!config.queue) return

  this.config = config.queue.rsmq || config.queue
  if (typeof this.config === 'string') {
    if (this.config.indexOf('redis://') === -1) this.config = 'redis://' + this.config
    this.url = this.config
    this.config = { client: redis.createClient(this.config) }
  }
  this.rsmq = new Rsmq(this.config)
  this.runtime = runtime

  this.rsmq.on('connect', () => { debug('redis connect') })
    .on('disconnect', () => { debug('redis disconnect') })
    .on('error', (err) => {
      debug('redis error', err)
      this.runtime.captureException(err)
    })
}

Queue.prototype.create = async function (name) {
  const self = this

  return new Promise((resolve, reject) => {
    self.rsmq.listQueues((err, rsp) => {
      if (err) {
        debug('listQueues failed')
        return reject(err)
      }
      if (rsp.indexOf(name) !== -1) return resolve(false)

      self.rsmq.createQueue({ qname: name }, (err, rsp) => {
        if (err) {
          debug('createQueue ' + name + ' failed')
          return reject(err)
        }

        if (rsp !== 1) return reject(new Error('createQueue ' + name + ' failed: unknown response'))
        resolve(true)
      })
    })
  })
}

Queue.prototype.drop = async function (name) {
  const self = this

  return new Promise((resolve, reject) => {
    self.rsmq.listQueues((err, rsp) => {
      if (err) {
        debug('listQueues failed')
        return reject(err)
      }
      if (rsp.indexOf(name) === -1) return resolve(false)

      self.rsmq.deleteQueue({ qname: name }, (err, rsp) => {
        if (err) {
          debug('deleteQueue ' + name + ' failed')
          return reject(err)
        }

        if (rsp !== 1) return reject(new Error('deleteQueue ' + name + ' failed: unknown response'))
        resolve(true)
      })
    })
  })
}

Queue.prototype.send = async function (debug, name, payload) {
  const self = this

  return new Promise((resolve, reject) => {
    self.rsmq.sendMessage({ qname: name, message: JSON.stringify(payload) }, (err, rsp) => {
      if (err) {
        debug('sendMessage ' + name + ' failed', payload)
        return reject(err)
      }

      if (!rsp) return reject(new Error('sendMessage failed: unknown response'))

      debug('send', { queue: name, message: payload })
      resolve(rsp)
    })
  })
}

Queue.prototype.recv = async function (name) {
  const self = this

  return new Promise((resolve, reject) => {
    self.rsmq.receiveMessage({ qname: name }, (err, rsp) => {
      if (err) {
        debug('receiveMessage ' + name + ' failed')
        return reject(err)
      }

      if ((!rsp) || (!rsp.id)) return null

      try { rsp.payload = JSON.parse(rsp.message) } catch (ex) {
        debug('receiveMessage ' + name + ' parsing failed', rsp)
        return reject(ex)
      }
      delete rsp.message

      debug('recv', { queue: name, message: rsp })
      resolve(rsp)
    })
  })
}

Queue.prototype.remove = async function (name, id) {
  const self = this

  return new Promise((resolve, reject) => {
    self.rsmq.deleteMessage({ qname: name, id: id }, (err, rsp) => {
      if (err) {
        debug('deleteMessage ' + name + ' id=' + id + ' failed')
        return reject(err)
      }

      return resolve(rsp === 1)
    })
  })
}

Queue.prototype.listen = function (name, callback) {
  const options = {
    host: this.rsmq.redis.options.host,
    port: this.rsmq.redis.options.port,
    options: underscore.omit(this.rsmq.redis.options, [ 'host', 'port' ])
  }
  const worker = new RsmqWorker(name, options)

  const oops = (message, extra, err) => {
    if (err) {
      debug(err, JSON.stringify(extra))
      this.runtime.captureException(err, { extra: extra })
    } else {
      debug(message, JSON.stringify(extra))
      this.runtime.captureException(message, { extra: extra })
    }
  }

  worker.on('message', (message, next, id) => {
    const rsp = { id: id, message: message }
    const ndebug = new SDebug('queue')
    let payload

    ndebug.initialize({ request: { id: id } })
    try {
      payload = JSON.parse(message)

      ndebug('recv', { queue: name, message: payload })
      callback(null, ndebug, payload)
    } catch (ex) {
      debug('listenMessage ' + name + ' parsing failed', rsp)
    }

    return next()
  })

  worker.on('error', (err, msg) => { oops('redis error', { id: msg.id }, err) })
    .on('exceeded', (msg) => { oops('redis exceeded', { id: msg.id }) })
    .on('timeout', (msg) => { oops('redis timeout', { id: msg.id, rc: msg.rc }) })

  worker.start()
}

module.exports = Queue
