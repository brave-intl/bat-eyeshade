const BigNumber = require('bignumber.js')
const Joi = require('joi')
const UpholdSDK = require('@uphold/uphold-sdk-javascript')
const boom = require('boom')
const underscore = require('underscore')
const SDebug = require('sdebug')

const utils = require('bat-utils')
const braveHapi = utils.extras.hapi
const braveJoi = utils.extras.joi

BigNumber.config({ EXPONENTIAL_AT: 28 })

const debug = new SDebug('balance')
const v2 = {}

/*
   GET /v2/card/BAT/{cardId}/balance
 */

v2.batBalance =
{ handler: (runtime) => {
  return async (request, reply) => {
    const cardId = request.params.cardId
    let fresh = false
    let expireIn = process.env.BALANCE_CACHE_TTL_S || 60 // 1 minute default

    let cardInfo = await runtime.cache.get(cardId, 'ledgerBalance:cardInfo')
    if (cardInfo) {
      cardInfo = JSON.parse(cardInfo)
    } else {
      try {
        cardInfo = await runtime.wallet.uphold.getCard(cardId)
      } catch (ex) {
        if (ex instanceof UpholdSDK.NotFoundError) {
          return reply(boom.notFound('no such cardId: ' + cardId))
        }
        throw ex
      }
      fresh = true
    }

    const altcurrency = cardInfo.currency
    const balanceProbi = new BigNumber(cardInfo.balance).times(runtime.currency.alt2scale(altcurrency))
    const spendableProbi = new BigNumber(cardInfo.available).times(runtime.currency.alt2scale(altcurrency))

    const balances = {
      altcurrency: altcurrency,
      probi: spendableProbi.toString(),
      balance: spendableProbi.dividedBy(runtime.currency.alt2scale(altcurrency)).toFixed(4),
      unconfirmed: balanceProbi.minus(spendableProbi).dividedBy(runtime.currency.alt2scale(altcurrency)).toFixed(4),
      rates: runtime.currency.rates[altcurrency]
    }

    reply(balances)

    if (fresh) {
      runtime.cache.set(cardId, JSON.stringify(cardInfo), { EX: expireIn }, 'ledgerBalance:cardInfo')
    }
  }
},

  description: 'Get the balance of a BAT card',
  tags: [ 'api' ],

  validate: {
    params: {
      cardId: Joi.string().guid().required().description('identity of the card')
    }
  },

  response: {
    schema: Joi.object().keys({
      altcurrency: Joi.string().required().description('the wallet currency'),
      balance: Joi.number().min(0).required().description('the (confirmed) wallet balance'),
      unconfirmed: Joi.number().min(0).required().description('the unconfirmed wallet balance'),
      rates: Joi.object().optional().description('current exchange rates to various currencies'),
      probi: braveJoi.string().numeric().required().description('the wallet balance in probi')
    })
  }
}

/*
   GET /v2/wallet/{paymentId}/balance
 */

v2.walletBalance =
{ handler: (runtime) => {
  return async (request, reply) => {
    const paymentId = request.params.paymentId
    let fresh = false
    let expireIn = process.env.BALANCE_CACHE_TTL_S || 60 // 1 minute default

    let walletInfo = await runtime.cache.get(paymentId, 'ledgerBalance:walletInfo')
    if (walletInfo) {
      walletInfo = JSON.parse(walletInfo)
    } else {
      try {
        const url = `${runtime.config.ledger.url}/v2/wallet/${paymentId}?refresh=true`
        debug('GET', url)
        walletInfo = await braveHapi.wreck.get(url, {
          redirects: 3,
          rejectUnauthorized: true,
          timeout: (5 * 1000),
          useProxyP: true
        })
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

    const balances = underscore.pick(walletInfo, ['altcurrency', 'probi', 'balance', 'unconfirmed', 'rates'])

    reply(balances)

    if (fresh) {
      runtime.cache.set(paymentId, JSON.stringify(walletInfo), { EX: expireIn }, 'ledgerBalance:walletInfo')
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
      probi: braveJoi.string().numeric().required().description('the wallet balance in probi')
    })
  }
}

module.exports.routes = [
  braveHapi.routes.async().path('/v2/card/BAT/{cardId}/balance').config(v2.batBalance),
  braveHapi.routes.async().path('/v2/wallet/{paymentId}/balance').config(v2.walletBalance)
]
