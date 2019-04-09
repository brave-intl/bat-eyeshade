'use strict'

import Currency from './runtime-currency'
import BigNumber from 'bignumber.js'
import test from 'ava'
import _ from 'underscore'
import {
  timeout
} from './extras-utils'
import {
  BAT_RATIOS_URL,
  BAT_RATIOS_TOKEN
} from '../../env'

const currency = make(Currency)

test('instantiates correctly', (t) => {
  t.plan(1)
  t.true(_.isObject(currency))
})

test('get the ratio', async (t) => {
  t.plan(2)
  const result = await currency.ratio('BAT', 'USD')
  t.true(_.isString(result))
  t.true(_.isNumber(+result))
})

test('get decimal scale', async (t) => {
  t.plan(2)
  t.is(currency.alt2scale('BAT'), '1e18')
  t.is(currency.alt2scale(), undefined)
})

test('get fiat 2 alt rate', async (t) => {
  t.plan(5)
  let result
  result = await currency.fiat2alt('USD', 5, 'BAT')
  t.true(_.isString(result))
  t.true(_.isNumber(+result))
  // make sure is integer
  t.true(parseInt(result) === +result)
  await t.throwsAsync(currency.fiat2alt('SSS', 1, 'BBB'))
  t.is(await currency.fiat2alt('USD', 0, 'BAT'), undefined)
})

test('get alt 2 fiat rate', async (t) => {
  t.plan(4)
  let resultNumber
  resultNumber = await currency.alt2fiat('BAT', 1, 'USD', true)
  resultNumber = new BigNumber(resultNumber)
  t.true(_.isNumber(+resultNumber))
  t.true(resultNumber > 0)
  resultNumber = await currency.alt2fiat('BAT', 1, 'USD')
  resultNumber = new BigNumber(resultNumber)
  const noDecimal = resultNumber.times(100)
  t.is(+noDecimal, Math.round(+noDecimal))
  await t.throwsAsync(currency.alt2fiat('SSS', 1, 'BBB'))
})

test('capture exception is passed up to runtime', async (t) => {
  t.plan(1)
  const error = {
    ignore: true
  }
  currency.runtime.captureException = (err) => {
    t.is(err, error)
  }
  currency.captureException(error)
  delete currency.runtime.captureException
})

test('rates are provided for basic tokens', async (t) => {
  const knownRateKeys = currency.knownRateKeys
  t.plan(2 + knownRateKeys.length)
  let result
  result = await currency.rates('BAT')
  t.true(_.isObject(result))
  t.true(knownRateKeys.length > 1)
  knownRateKeys.forEach((key) => {
    t.true(_.isNumber(+result[key]))
  })
})
test('make sure cache is caching', async (t) => {
  t.plan(1)
  const oldCache = currency.cache
  const trueResult = await currency.rates('BAT')
  const ones = _.mapObject(trueResult, () => '1')
  const oneResult = {
    lastUpdated: (new Date()).toISOString(),
    payload: Object.assign({}, ones, {
      BAT: '1'
    })
  }
  const createCache = (context) => ({
    set: () => {},
    get: (key) => oneResult
  })
  currency.cache = createCache({})
  const result = await currency.rates('BAT')
  t.deepEqual(ones, result)
  currency.cache = oldCache
})

test('a faulty request does not result in an error', async (t) => {
  t.plan(2)
  const currency = make(Currency.Constructor)
  currency.cache = currency.Cache()
  currency.parser = () => { throw new Error('missed') }
  // throwing with no cache
  try {
    await currency.rates('BAT')
  } catch (e) {
    t.true(_.isObject(e))
  }
  // caching
  delete currency.parser
  const res1 = await currency.rates('BAT')
  let res2 = null
  try {
    res2 = await currency.rates('BAT')
  } catch (e) {
    t.true(false)
  }
  t.deepEqual(res1, res2)
  currency.cache = currency.Cache()
})

test('a faulty request delays subsequent requests', async (t) => {
  t.plan(4)
  const currency = make(Currency.Constructor, {
    lastFailure: 5000
  })
  const first = await currency.rates('BAT')
  currency.parser = () => { throw new Error('missed') }
  currency.request = _.wrap(currency.request, (request, endpoint) => {
    t.true(true)
    return request.call(currency, endpoint)
  })
  t.deepEqual(first, await currency.rates('BAT'))
  await timeout(6000)
  t.deepEqual(first, await currency.rates('BAT'))
  currency.cache = currency.Cache()
  try {
    await currency.rates('BAT')
  } catch (e) {
    t.true(_.isObject(e))
  }
})

function make (Constructor = Currency, options = {}) {
  return new Constructor({
    currency: Object.assign({
      url: BAT_RATIOS_URL,
      access_token: BAT_RATIOS_TOKEN
    }, options)
  }, {
    captureException: () => {}
  })
}
