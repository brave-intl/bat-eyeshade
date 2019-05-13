// TODO: add GC statistics

import SDebug from 'sdebug'
import client from 'prom-client'
import exposition from 'exposition'
import redis from 'redis'
import underscore from 'underscore'
const debug = new SDebug('prometheus')

const Prometheus = function (config, runtime): void {
  if (!(this instanceof Prometheus)) return new Prometheus(config, runtime)

  this.metrics = {}

  if (!config.prometheus) return

  this.label = config.prometheus.label
  this.runtime = runtime
  this.local = {}
  this.global = {}

  if (config.prometheus.redis) this.publisher = redis.createClient(config.prometheus.redis)
  this.msgno = 0

  setInterval(this.maintenance.bind(this), 10 * 1000)
}

Prometheus.prototype.plugin = function () {
  const self = this
  const registry = client.register
  const register = (server, o, done) => {
    server.route({
      method: 'GET',
      path: '/metrics',
      handler: (req, reply) => { reply(exposition.stringify(underscore.values(self.global))).type('text/plain') }
    })

    server.route({
      method: 'GET',
      path: '/metrics-internal',
      handler: (req, reply) => { reply(client.register.metrics()).type('text/plain') }
    })

    server.ext('onRequest', (request, reply) => {
      request.prometheus = { start: process.hrtime() }
      reply.continue()
    })

    server.on('response', (response) => {
      const analysis = response._route._analysis
      const statusCode = response.response.statusCode
      let cardinality, diff, duration, method, metric, params, path

      diff = process.hrtime(response.prometheus.start)
      duration = Math.round((diff[0] * 1e9 + diff[1]) / 1000000)

      method = response.method.toLowerCase()
      params = underscore.clone(analysis.params)
      cardinality = params.length ? 'many' : 'one'
      path = analysis.fingerprint.split('/')
      for (let i = 0; i < path.length; i++) { if (path[i] === '?') path[i] = '{' + (params.shift() || '?') + '}' }
      path = path.join('/')

      metric = (registry as any)._metrics['http_request_buckets_milliseconds']
      if (!metric) {
        metric = new client.Summary({
          name: 'http_request_duration_milliseconds',
          help: 'request duration in milliseconds',
          labelNames: ['method', 'path', 'cardinality', 'status']
        })
      }
      metric.labels(method, path, cardinality, statusCode).observe(duration)

      metric = (registry as any)._metrics['http_request_buckets_milliseconds']
      if (!metric) {
        metric = new client.Histogram({
          name: 'http_request_buckets_milliseconds',
          help: 'request duration buckets for 500 and 2000 milliseconds',
          labelNames: ['method', 'path', 'cardinality', 'status'],
          buckets: [ 500, 2000 ]
        })
      }
      metric.labels(method, path, cardinality, statusCode).observe(duration)
    })

    self.subscribeP = true

    return done()
  }
  register.attributes = {
    name: 'runtime-prometheus',
    version: '1.0.0'
  }
  const plugin = {
    register
  }

  return plugin
}

Prometheus.prototype.maintenance = function () {
  const self = this

  const entries = exposition.parse(client.register.metrics())
  let updates

  if (!self.subscribeP) client.collectDefaultMetrics()

  const merge = (source) => {
    source.forEach((update) => {
      const name = update.name
      let entry

      if (!(update.metrics && update.metrics.length)) return

      entry = self.global[name]
      if (!entry) {
        self.global[name] = update
        return
      }

      update.metrics.forEach((metric) => {
        let offset, tag

        if (metric.buckets) {
          tag = underscore.first(underscore.keys(metric.buckets))

          offset = underscore.findIndex(entry.metrics, (value) => {
            return (underscore.keys(value.buckets || {}).indexOf(tag) !== -1)
          })
        } else {
          offset = underscore.findIndex(entry.metrics, (value) => {
            return underscore.isEqual(metric.labels, value.labels)
          })
        }

        if (offset < 0) entry.metrics.push(metric)
        else entry.metrics.splice(offset, 1, metric)
      })
    })
  }

  updates = []
  entries.forEach((entry) => {
    const metrics = []
    const name = entry.name

    // no metrics(?) or no change
    if ((!entry.metrics) || (underscore.isEqual(self.local[name] || {}, entry))) return

    self.local[name] = entry
    entry.metrics.forEach((metric) => {
      const buckets = {}

      if (metric.buckets) {
        for (let bucket in metric.buckets) {
          const kvs = bucket.split(',')

          kvs.splice(1, 0, 'instance="' + self.label + '"')
          buckets[kvs.join(',')] = metric.buckets[bucket]
        }
        metric.buckets = buckets
      } else {
        metric.labels = underscore.extend(metric.labels || {}, { instance: self.label })
      }
      metrics.push(metric)
    })
    entry.metrics = metrics
    updates.push(entry)
  })
  if (!updates.length) return

  merge(updates)

  if (!self.publisher) {
    self.publisher = (self.runtime.cache && self.runtime.cache.cache) || self.runtime.queue.config.client
    if (!self.publisher) return
  }

  self.publisher.publish('prometheus:' + process.env.SERVICE, JSON.stringify({
    label: self.label,
    msgno: self.msgno++,
    updates: updates
  }))
  if (self.label.indexOf('.worker.') !== -1) return

  if ((self.subscriber) || (!self.subscribeP)) return

  self.subscriber = self.publisher.duplicate().on('subscribe', (channel, count) => {
    debug('subscribe', { channel: channel, count: count })
  }).on('message', (channel, message) => {
    let packet

    try {
      packet = JSON.parse(message)
    } catch (ex) {
      return debug('message', { error: ex.toString() })
    }

    if (packet.label === self.label) return

    if (packet.msgno === 0) {
      self.publisher.publish('prometheus:' + process.env.SERVICE, JSON.stringify({
        label: self.label,
        msgno: self.msgno++,
        updates: underscore.values(self.global || {})
      }))
    }

    merge(packet.updates)
  })

  self.subscriber.subscribe('prometheus:' + process.env.SERVICE)
}

Prometheus.prototype.setCounter = async function (name, help, value) {
  if (!this.metrics[name]) this.metrics[name] = new client.Counter({ name: name, help: help })

  this.metrics[name].reset()
  this.metrics[name].inc(value)
}

Prometheus.prototype.incrCounter = async function (name, help, delta) {
  if (!this.metrics[name]) this.metrics[name] = new this.client.Counter({ name: name, help: help })

  this.metrics[name].inc(delta)
}

Prometheus.prototype.setGauge = async function (name, help, value) {
  if (!this.metrics[name]) this.metrics[name] = new this.client.Gauge({ name: name, help: help })

  this.metrics[name].set(value)
}

export default Prometheus
