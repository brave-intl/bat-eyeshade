const Joi = require('joi')
const boom = require('boom')
const underscore = require('underscore')
const SDebug = require('sdebug')

const utils = require('bat-utils')
const braveHapi = utils.extras.hapi
const braveJoi = utils.extras.joi
const { BALANCE_CACHE_TTL_S } = require('../../env')

const plugins = {
  rateLimit: {
    enabled: true,
    rate: () => ({
      limit: 60000,
      window: 60
    })
  }
}

const expireIn = BALANCE_CACHE_TTL_S || 60 // 1 minute default
const expireSettings = {
  EX: expireIn
}

const debug = new SDebug('balance')
const v2 = {}

const cacheConfig = {
  link: 'ledgerBalance:walletByCardId',
  card: 'ledgerBalance:cardInfo',
  wallet: 'ledgerBalance:walletInfo'
}

module.exports.configuration = {
  cache: cacheConfig
}

/*
   GET /v2/wallet/{paymentId}/balance
 */

v2.walletBalance =
{ handler: (runtime) => {
  return async (request, reply) => {
    const paymentId = request.params.paymentId
    let fresh = false
    const { wallet, link } = cacheConfig

    let walletInfo = await runtime.cache.get(paymentId, wallet)
    if (walletInfo) {
      walletInfo = JSON.parse(walletInfo)
    } else {
      try {
        const url = `${runtime.config.ledger.url}/v2/wallet/${paymentId}?refresh=true`
        debug('GET', url)
        walletInfo = await braveHapi.wreck.get(url, { useProxyP: true })
        if (Buffer.isBuffer(walletInfo)) walletInfo = JSON.parse(walletInfo)
      } catch (ex) {
        if (ex.isBoom) {
          return reply(ex)
        } else {
          return reply(boom.boomify(ex))
        }
      }
      fresh = true
    }

    const balances = underscore.pick(walletInfo, ['altcurrency', 'probi', 'balance', 'unconfirmed', 'rates', 'parameters', 'grants'])

    reply(balances)

    if (fresh) {
      let cardId = accessCardId(walletInfo)
      runtime.cache.set(cardId, paymentId, {}, link)
      runtime.cache.set(paymentId, JSON.stringify(walletInfo), expireSettings, wallet)
    }
  }
},

  description: 'Get the balance of a ledger wallet',
  tags: [ 'api' ],

  validate: {
    params: {
      paymentId: Joi.string().guid().required().description('identity of the wallet')
    }
  },

  response: {
    schema: Joi.object().keys({
      altcurrency: Joi.string().required().description('the wallet currency'),
      balance: Joi.number().min(0).required().description('the (confirmed) wallet balance'),
      unconfirmed: Joi.number().min(0).required().description('the unconfirmed wallet balance'),
      rates: Joi.object().optional().description('current exchange rates to various currencies'),
      probi: braveJoi.string().numeric().required().description('the wallet balance in probi'),
      parameters: Joi.object().keys().unknown(true).optional().description('global wallet parameters'),
      grants: Joi.array().optional().items(Joi.object().keys({
        probi: braveJoi.string().numeric().optional().description('the grant value in probi'),
        altcurrency: Joi.string().optional().description('the grant currency'),
        expiryTime: Joi.number().optional().description('unix timestamp when the grant expires')
      }))
    })
  }
}

/*
   DELETE /v2/wallet/{paymentId}/balance
 */

v2.invalidateWalletBalance =
{ handler: (runtime) => {
  return async (request, reply) => {
    const paymentId = request.params.paymentId

    await runtime.cache.del(paymentId, cacheConfig.wallet)

    reply({})
  }
},
  auth: {
    strategy: 'simple',
    mode: 'required'
  },

  description: 'Invalidate the cached balance of a ledger wallet',
  tags: [ 'api' ],

  validate: {
    params: {
      paymentId: Joi.string().guid().required().description('identity of the wallet')
    }
  },

  response: { schema: Joi.object().length(0) }
}

/*
   POST /v2/card
 */

v2.invalidateCardBalance =
{ handler: (runtime) => {
  return async (request, reply) => {
    const hapiPayload = request.payload
    const upholdPayload = hapiPayload.payload
    const cardId = upholdPayload.id
    const { cache } = runtime

    const { link, wallet } = cacheConfig

    debug(`accessing cardId: ${cardId}`)
    const paymentId = await cache.get(cardId, link)

    if (paymentId) {
      debug(`removing paymentId: ${paymentId}`)
      await cache.del(paymentId, wallet)
    }

    reply({})
  }
},
  plugins,
  description: 'Invalidate the cached balance of a ledger wallet',
  tags: [ 'api' ],

  validate: {
    payload: Joi.object({
      payload: Joi.object().keys({
        id: Joi.string().guid().required().description('identity of the card')
      }).unknown(true)
    }).unknown(true)
  },

  response: { schema: Joi.object().length(0) }
}

module.exports.routes = [
  braveHapi.routes.async().path('/v2/wallet/{paymentId}/balance').config(v2.walletBalance),
  braveHapi.routes.async().delete().path('/v2/wallet/{paymentId}/balance').config(v2.invalidateWalletBalance),
  braveHapi.routes.async().post().path('/v2/card').config(v2.invalidateCardBalance)
]

module.exports.accessCardId = accessCardId

function accessCardId (wallet) {
  return wallet && wallet.addresses && wallet.addresses.CARD_ID
}
