const client = require('prom-client')
const { BigNumber } = require('./extras-utils')
const _ = require('underscore')
const listenerPrefix = 'listeners:prometheus:'
const listenerChannel = `${listenerPrefix}${process.env.SERVICE}`

module.exports = Prometheus

const settlementBalanceKey = 'settlement:balance'

module.exports = Prometheus

function Prometheus (config, runtime) {
  if (!(this instanceof Prometheus)) {
    return new Prometheus(config, runtime)
  }

  const { prometheus } = config
  if (!prometheus) return

  const { label: dyno } = prometheus
  this.config = prometheus
  this.register = new client.Registry()
  this.client = client
  this.runtime = runtime
  this.metrics = {}
  this.shared = {}
  this.listenerId = `${listenerPrefix}${dyno}`

  this.register.setDefaultLabels({ dyno })

  const timeout = 10000
  this.timeout = timeout
  setInterval(() => this.maintenance(), timeout)
  process.on('exit', () => {
    try {
      this.quit()
    } catch (e) {
      this.runtime.captureException(e)
    }
  })
  this.registerMetrics()
  this.registerMetrics = _.noop
}

Prometheus.prototype.cache = function () {
  const { runtime } = this
  const { cache, queue } = runtime
  return cache ? cache.cache : queue.config.client
}

Prometheus.prototype.maintenance = async function () {
  const { interval, timeout, client, register } = this
  this.interval = interval || client.collectDefaultMetrics({
    timeout,
    register
  })
  await this.merge()
}

Prometheus.prototype.duration = function (start) {
  const diff = process.hrtime(start)
  return Math.round((diff[0] * 1e9 + diff[1]) / 1000000)
}

Prometheus.prototype.quit = function () {
  clearInterval(this.interval)
}

Prometheus.prototype.allMetrics = async function () {
  const { client } = this
  const cache = this.cache()
  const keys = await cache.keysAsync(`${listenerChannel}.*`)
  const all = await cache.mgetAsync(keys)
  const metrics = all.map(JSON.parse)
  return client.AggregatorRegistry.aggregate(metrics)
}

Prometheus.prototype.exponentialBuckets = function () {
  return this.client.exponentialBuckets(2, 2, 15)
}

Prometheus.prototype.registerMetrics = function () {
  const { client, register } = this
  const log2Buckets = this.exponentialBuckets()

  new client.Summary({ // eslint-disable-line
    registers: [register],
    name: 'http_request_duration_milliseconds',
    help: 'request duration in milliseconds',
    labelNames: ['method', 'path', 'cardinality', 'status']
  })

  new client.Histogram({ // eslint-disable-line
    registers: [register],
    name: 'http_request_buckets_milliseconds',
    help: 'request duration buckets in milliseconds',
    labelNames: ['method', 'path', 'cardinality', 'status'],
    buckets: log2Buckets
  })

  new client.Histogram({ // eslint-disable-line
    registers: [register],
    name: 'uphold_request_buckets_milliseconds',
    help: 'uphold request duration buckets in milliseconds',
    labelNames: ['method', 'path', 'cardinality', 'status'],
    buckets: log2Buckets
  })

  new client.Histogram({ // eslint-disable-line
    registers: [register],
    name: 'anonizeVerify_request_buckets_milliseconds',
    help: 'anonize verify duration buckets in milliseconds',
    labelNames: ['erred'],
    buckets: log2Buckets
  })

  new client.Histogram({ // eslint-disable-line
    registers: [register],
    name: 'anonizeRegister_request_buckets_milliseconds',
    help: 'anonize register buckets in milliseconds',
    labelNames: ['erred'],
    buckets: log2Buckets
  })

  new client.Histogram({ // eslint-disable-line
    registers: [register],
    name: 'viewRefresh_request_buckets_milliseconds',
    help: 'postgres view refresh buckets in milliseconds',
    labelNames: ['method', 'path', 'cardinality', 'status', 'erred'],
    buckets: log2Buckets
  })

  new client.Counter({ // eslint-disable-line
    registers: [register],
    name: 'funds_received_count',
    help: 'a count of the number of bat added to the settlement wallet'
  })

  new client.Counter({ // eslint-disable-line
    registers: [register],
    name: 'settlement_balance_counter',
    help: 'a count up of the number of bat removed from the settlement wallet'
  })

  new client.Counter({ // eslint-disable-line
    registers: [register],
    name: 'votes_issued_counter',
    help: 'ballots that were issued to the browser',
    labelNames: ['cohort']
  })

  new client.Counter({ // eslint-disable-line
    registers: [register],
    name: 'referral_received_counter',
    help: 'the number of referrals received from promotion server'
  })

  new client.Counter({ // eslint-disable-line
    registers: [register],
    name: 'referral_inserted_counter',
    help: 'the number of referrals inserted to the transactions table'
  })
}

Prometheus.prototype.plugin = function () {
  const plugin = {
    name: 'runtime-prometheus',
    version: '1.0.0',
    register: async (server, o) => {
      server.route({
        method: 'GET',
        path: '/metrics',
        handler: async (req, h) => {
          const registry = await this.allMetrics()
          const metrics = registry.metrics()
          return h.response(metrics).type('text/plain')
        }
      })

      server.route({
        method: 'GET',
        path: '/metrics-internal',
        handler: (req, h) => h.response(this.register.metrics()).type('text/plain')
      })

      server.ext('onRequest', (request, h) => {
        request.prometheus = { start: process.hrtime() }
        return h.continue
      })

      server.events.on('response', (response) => {
        const analysis = response._route._analysis
        const statusCode = response.response.statusCode
        let path

        const duration = this.duration(response.prometheus.start)

        const method = response.method.toLowerCase()
        const params = _.clone(analysis.params)
        const cardinality = params.length ? 'many' : 'one'
        path = analysis.fingerprint.split('/')
        for (let i = 0; i < path.length; i++) { if (path[i] === '?') path[i] = '{' + (params.shift() || '?') + '}' }
        path = path.join('/')

        const observables = {
          method,
          path,
          cardinality,
          status: statusCode || 0
        }
        this.getMetric('http_request_duration_milliseconds')
          .observe(observables, duration)

        this.getMetric('http_request_buckets_milliseconds')
          .observe(observables, duration)
      })

      this.maintenance()
    }
  }

  return plugin
}

Prometheus.prototype.getMetric = function (name) {
  return this.register.getSingleMetric(name)
}

Prometheus.prototype.timedRequest = function (name, knownObs = {}) {
  const metric = this.getMetric(name)
  const start = process.hrtime()
  return (moreObs = {}) => {
    const duration = this.duration(start)
    const labels = Object.assign({}, knownObs, moreObs)
    metric.observe(labels, duration)
  }
}

Prometheus.prototype.publish = async function () {
  const { register, timeout, listenerId } = this
  // x2 for buffer
  const timeoutSeconds = (timeout / 1000) * 2
  const data = register.getMetricsAsJSON()
  const json = JSON.stringify(data)
  await this.cache().setAsync(listenerId, json, 'EX', timeoutSeconds)
}

Prometheus.prototype.merge = async function () {
  await this.publish()
  if (this.config.label.includes('.worker.')) {
    return
  }
  await this.ifFirstWebRun(() => autoUpdateMetrics(this.runtime))
}

Prometheus.prototype.ifFirstWebRun = async function (fn) {
  if (this.config.label === 'ledger.web.1') {
    // only write from one dyno
    await fn()
  }
}

async function autoUpdateMetrics (runtime) {
  await updateSettlementWalletMetrics(runtime)
}

async function updateSettlementWalletMetrics (runtime) {
  if (!runtime.wallet) {
    return // can't do anything without wallet
  }
  await pullSettlementWalletBalanceMetrics(runtime)
}

async function pullSettlementWalletBalanceMetrics (runtime) {
  const { prometheus } = runtime
  const metric = prometheus.getMetric('funds_received_count')
  const currentBalance = await getSettlementBalance(runtime)
  const lastBalanceCached = await prometheus.cache().getAsync(settlementBalanceKey)
  const lastBalance = new BigNumber(lastBalanceCached || currentBalance.toString())
  let delta = currentBalance.minus(lastBalance)
  if (delta.lessThan(0)) {
    // settlement happened, or first cache
    // either way, reset counter is fine
    delta = new BigNumber(0)
  }
  // increment counter
  metric.inc(+delta)
  // cache currently known balance
  await prometheus.cache().setAsync([settlementBalanceKey, currentBalance.toString(), 'EX', 60 * 60])
}

async function getSettlementBalance (runtime) {
  const { wallet } = runtime
  const settlement = await wallet.getSettlementWallet()
  return new BigNumber(settlement.balance)
}
