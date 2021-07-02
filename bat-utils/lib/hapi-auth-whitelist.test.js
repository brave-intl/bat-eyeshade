'use strict'
const _ = require('underscore')
const {
  validateHops,
  forwardedIPShift,
  ipInList,
  ipaddr
} = require('./hapi-auth-whitelist.js')
const {
  serial: test
} = require('ava')

const dotenv = require('dotenv')
dotenv.config()

const validFastlyToken = process.env.FASTLY_TOKEN_LIST

test('ipaddr', async (t) => {
  t.is(ipaddr(req('123.123.123.123', '127.0.0.1,12.12.12.12')), '12.12.12.12')
  t.is(ipaddr(req('123.123.123.123', '127.0.0.1, 12.12.12.12')), '12.12.12.12')
  t.is(ipaddr(req('123.123.123.123')), '123.123.123.123')
  t.is(ipaddr(req('123.123.123.123', ' ')), '123.123.123.123')
})

test('validateHops', async (t) => {
  await munge(['FASTLY_TOKEN_LIST', 'FORWARDED_IP_SHIFT'], (setEnvs) => {
    const run = (token) => {
      const remoteAddress = '123.123.123.123'
      const xForwardedFor = '1.1.1.1,2.2.2.2,3.3.3.3'
      const tkn = token || validFastlyToken
      const request = req(remoteAddress, xForwardedFor, tkn)
      validateHops(request)
      return ipaddr(request)
    }

    setEnvs([null, null])
    t.is(run(), '3.3.3.3', 'should not throw in default state')
    t.is(run('invalid'), '3.3.3.3', 'an invalid fastly token is ignored when no shift exists')

    setEnvs([validFastlyToken, null])
    t.is(run(), '3.3.3.3', 'should not throw when token is sent but no shift exists')
    t.is(run('invalid'), '3.3.3.3', 'an invalid fastly token is ignored when no shift exists')

    setEnvs([null, '2'])
    t.throws(run, { instanceOf: Error }, 'should throw when no token is sent but shift exists')
    t.throws(() => run('invalid'), { instanceOf: Error }, 'an invalid fastly token throws when shift exists')

    setEnvs([validFastlyToken, '2'])
    t.is(run(), '2.2.2.2', 'should not throw when shift exists and fastly token matches')
    t.throws(() => run('invalid'), { instanceOf: Error }, 'an invalid fastly token throws when shift exists')
  })
})

test('ipaddr can be shifted', async (t) => {
  await munge(['FORWARDED_IP_SHIFT'], (setEnvs) => {
    t.is(ipaddr(req('', '0.0.0.0,8.8.8.8,9.0.0.0')), '9.0.0.0', 'by default the last ip is taken')
    setEnvs(['2'])
    t.is(ipaddr(req('', '0.0.0.0,8.8.8.8,9.0.0.0')), '8.8.8.8', 'by changing the env, you can choose which ip in the list of forwarded ips to take by default')
  })
})

test('shift amount can be retrieved', async (t) => {
  await munge(['FORWARDED_IP_SHIFT'], (setEnvs) => {
    t.is(forwardedIPShift(), 1, 'by default it is one')
    setEnvs(['3'])
    t.is(forwardedIPShift(), 3, 'but can be overwritten')
    setEnvs(['what'])
    t.throws(forwardedIPShift, { instanceOf: Error }, 'non numeric values throw')
    setEnvs(['-2'])
    t.is(forwardedIPShift(), 1, 'negative numbers are clamped to 1')
  })
})

test('is whitelisted', async (t) => {
  const hardcode = '127.0.0.1'
  const mask = '127.0.0.0/24'
  const scenarios = [
    { value: hardcode, [hardcode]: true, [mask]: true },
    { value: '127.0.0', [hardcode]: false, [mask]: true },
    { value: '127.0.0.2', [hardcode]: false, [mask]: true },
    { value: '127.0.1.0', [hardcode]: false, [mask]: false },
    { value: '192.168.1.0', [hardcode]: false, [mask]: false }
  ]
  scenarios.forEach((scenario) => {
    t.is(scenario[hardcode], ipInList(hardcode, scenario.value))
    t.is(scenario[mask], ipInList(mask, scenario.value))
  })
  t.throws(() => ipInList('127.0.0.1:3000', hardcode), Error)
})

function req (remoteAddress, XForwardedFor, token = validFastlyToken) {
  return {
    headers: XForwardedFor ? {
      'fastly-token': token,
      'x-forwarded-for': XForwardedFor
    } : {},
    info: {
      remoteAddress
    }
  }
}

async function munge (keys, handler) {
  const cachedEnv = _.toArray(keys).map((key) => process.env[key])
  await handler(setEnvs)
  setEnvs(cachedEnv)

  function setEnvs (values = []) {
    _.toArray(values).forEach((value, index) => {
      const key = keys[index]
      if (_.isString(value)) {
        process.env[key] = value
      } else {
        delete process.env[key]
      }
    })
  }
}
