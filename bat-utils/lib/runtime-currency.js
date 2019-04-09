const url = require('url')
const SDebug = require('sdebug')
const currencyCodes = require('currency-codes')
const braveHapi = require('./extras-hapi')
const BigNumber = require('bignumber.js')
const _ = require('underscore')
const debug = new SDebug('currency')
let singleton
const oneMin = 1000 * 60
const ms5min = 5 * oneMin
const failureDebounceTime = oneMin

const knownRateKeys = [ 'AED', 'ARS', 'AUD', 'BAT', 'BCH', 'BRL', 'BTC', 'BTG', 'CAD', 'CHF', 'CNY', 'DASH', 'DKK', 'ETH', 'EUR', 'GBP', 'HKD', 'ILS', 'INR', 'JPY', 'KES', 'LBA', 'LTC', 'MXN', 'NOK', 'NZD', 'PHP', 'PLN', 'SEK', 'SGD', 'USD', 'XAG', 'XAU', 'XPD', 'XPT', 'XRP' ]
// satoshis, wei, etc.
const decimals = {
  BAT: 18,
  BCH: 8,
  BTC: 8,
  ETC: 18,
  ETH: 18,
  LTC: 8,
  NMC: 8,
  PPC: 6,
  XPM: 8,
  ZEC: 8
}

const Cache = (cache = {}) => ({
  get: (key) => cache[key],
  set: (key, value) => {
    cache[key] = value
  }
})

generateGlobal.Cache = Cache
generateGlobal.knownRateKeys = knownRateKeys
generateGlobal.decimals = decimals

Currency.Cache = Cache

module.exports = generateGlobal
generateGlobal.Constructor = Currency

Currency.prototype = {
  decimals,
  knownRateKeys,
  Cache,
  parser: function (buffer) {
    return JSON.parse(buffer.toString())
  },

  request: async function (endpoint) {
    const context = this
    const {
      config
    } = context
    const {
      access_token: accessToken = 'foobarfoobar'
    } = config
    const authorization = `Bearer ${accessToken}`
    const options = {
      useProxyP: true,
      headers: {
        authorization,
        'content-type': 'application/json'
      }
    }
    return braveHapi.wreck.get(endpoint, options)
  },

  access: async function (path) {
    const context = this
    const {
      config,
      cache
    } = context
    let {
      url: currencyUrl,
      updateTime,
      failureDebounceTime
    } = config
    const baseUrl = url.resolve(currencyUrl, '/v1/')
    const endpoint = url.resolve(baseUrl, path)
    const cacheKey = `currency:${endpoint}`
    let data = cache.get(cacheKey)
    if (data) {
      const {
        lastUpdated,
        lastFailure,
        payload
      } = data
      const lastDate = new Date(lastUpdated)
      const lastAcceptableCache = new Date() - updateTime
      if (lastDate > lastAcceptableCache) {
        return payload
      }
      if (new Date(lastFailure) > (new Date()) - failureDebounceTime) {
        return payload
      }
    }
    try {
      const body = await context.request(endpoint)
      data = context.parser(body)
    } catch (err) {
      context.captureException(err)
      if (data) {
        data.lastFailure = (new Date()).toISOString()
      }
    }
    cache.set(cacheKey, data)
    return data.payload
  },

  all: function () {
    return this.access('./')
  },

  rates: async function (against, currencies) {
    const context = this
    const rateCurrencies = currencies || context.knownRateKeys
    const rates = await context.all()
    const number = rates[against]
    const base = new BigNumber(number.toString())
    return _.reduce(rateCurrencies, (memo, key) => {
      const value = rates[key]
      if (value) {
        const price = new BigNumber(value.toString())
        memo[key] = price.dividedBy(base).toString()
      }
      return memo
    }, {})
  },

  ratio: function (a, b) {
    return this.access(`${a}/${b}`)
  },

  // satoshis, wei, etc.
  alt2scale: function (altcurrency) {
    const scale = this.decimals[altcurrency]

    if (scale) {
      return ('1e' + scale.toString())
    }
  },

  alt2fiat: async function (altcurrency, probi, currency, floatP) {
    let rate = await singleton.ratio(altcurrency, currency)
    if (!rate) {
      return
    }
    const entry = currencyCodes.code(currency)
    const scale = singleton.alt2scale(altcurrency)
    let amount

    if (!(probi instanceof BigNumber)) {
      probi = new BigNumber(probi.toString())
    }
    amount = probi.times(new BigNumber(rate.toString()))
    if (floatP) {
      return amount
    }

    if (scale) {
      amount = amount.dividedBy(scale)
    }

    return amount.toFixed(entry ? entry.digits : 2)
  },

  captureException: function (e) {
    debug('accessing currency ratios failed', {
      message: e.message,
      code: e.statusCode,
      stack: e.stack
    })
    this.runtime.captureException(e)
  },

  fiat2alt: async function (currency, amount, altcurrency) {
    if (!amount) {
      return
    }

    let rate = await singleton.ratio(altcurrency, currency)
    if (!rate) {
      return
    }

    const scale = singleton.alt2scale(altcurrency)
    let probi

    if (!(amount instanceof BigNumber)) {
      amount = new BigNumber(amount.toString())
    }
    probi = amount.dividedBy(new BigNumber(rate.toString()))

    if (scale) {
      probi = probi.times(scale)
    }

    return probi.floor().toString()
  }
}

function generateGlobal (config, runtime) {
  if (!singleton) {
    singleton = new Currency(config, runtime)
  }
  return singleton
}

function Currency (config, runtime) {
  const context = this
  const conf = config.currency
  if (!conf.url) {
    throw new Error('currency ratios url is required')
  }

  context.config = Object.assign({
    updateTime: ms5min,
    failureDebounceTime,
    BigNumber
  }, conf)

  const { BigNumber: BigNum } = context.config
  context.BigNumber = BigNum
  BigNumber.config({
    EXPONENTIAL_AT: 28,
    DECIMAL_PLACES: 18
  })

  context.runtime = runtime
  context.debug = debug
  context.cache = Currency.Cache()
}
