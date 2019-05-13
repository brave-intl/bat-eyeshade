import BigNumber from 'bignumber.js'
import boom from 'boom'
import bson from 'bson'
import Joi from 'joi'
import underscore from 'underscore'
import utils from 'bat-utils'

const braveHapi = utils.extras.hapi
const braveJoi = utils.extras.joi

let altcurrency

/*
   POST /v2/publishers/settlement
 */

const v2Settlement = {
  handler: (runtime) => {
    return async (request, reply) => {
      const {
        payload
      } = request
      const { fromString } = bson.Decimal128
      const debug = braveHapi.debug(module, request)
      const settlements = runtime.database.get('settlements', debug)
      const numberFields = [ 'probi', 'amount', 'fee', 'fees', 'commission' ]
      const mappedFields = [ 'address', 'altcurrency', 'currency', 'hash', 'type', 'owner', 'documentId' ]

      if (payload.find((entry) => entry.altcurrency !== altcurrency)) {
        return reply(boom.badData('altcurrency should be ' + altcurrency))
      }

      const $currentDate = { timestamp: { $type: 'timestamp' } }
      const executedTime = new Date()
      const settlementGroups = {}
      for (let entry of payload) {
        const {
          commission,
          fee,
          type,
          publisher,
          executedAt,
          transactionId: settlementId
        } = entry

        const bigFee = new BigNumber(fee)
        const bigCom = new BigNumber(commission)
        const bigComPlusFee = bigCom.plus(bigFee)

        let picked = underscore.pick(entry, mappedFields)
        picked.commission = fromString(bigComPlusFee.toString())
        picked.executedAt = new Date(executedAt || executedTime)
        const $set = numberFields.reduce((memo, field) => {
          memo[field] = fromString(entry[field].toString())
          return memo
        }, picked)

        const state = {
          $set,
          $currentDate
        }

        await settlements.update({
          settlementId,
          publisher
        }, state, { upsert: true })

        let entries = settlementGroups[type]
        if (!entries) {
          entries = []
          settlementGroups[type] = entries
        }
        entries.push(settlementId)
      }

      for (let type in settlementGroups) {
        const settlementIds = underscore.uniq(settlementGroups[type])
        for (let settlementId of settlementIds) {
          await runtime.queue.send(debug, 'settlement-report', {
            type,
            settlementId,
            shouldUpdateBalances: true
          })
        }
      }

      reply({})
    }
  },

  auth: {
    strategies: ['session', 'simple-scoped-token'],
    scope: ['ledger', 'publishers'],
    mode: 'required'
  },
  payload: {
    maxBytes: 1024 * 1024 * 20 // 20 MB
  },
  description: 'Posts a settlement for one or more publishers',
  tags: [ 'api' ],

  validate: {
    payload: Joi.array().min(1).items(Joi.object().keys({
      executedAt: braveJoi.date().iso().optional().description('the timestamp the settlement was executed'),
      owner: braveJoi.string().owner().required().description('the owner identity'),
      publisher: braveJoi.string().publisher().when('type', { is: Joi.string().valid('manual'), then: Joi.optional().allow(''), otherwise: Joi.required() }).description('the publisher identity'),
      address: Joi.string().guid().required().description('settlement address'),
      altcurrency: braveJoi.string().altcurrencyCode().required().description('the altcurrency'),
      probi: braveJoi.string().numeric().required().description('the settlement in probi'),
      fees: braveJoi.string().numeric().default('0.00').description('processing fees'),
      currency: braveJoi.string().anycurrencyCode().default('USD').description('the deposit currency'),
      amount: braveJoi.string().numeric().required().description('the amount in the deposit currency'),
      commission: braveJoi.string().numeric().default('0.00').description('settlement commission'),
      fee: braveJoi.string().numeric().default('0.00').description('fee in addition to settlement commission'),
      transactionId: Joi.string().guid().required().description('the transactionId'),
      type: Joi.string().valid('contribution', 'referral', 'manual').default('contribution').description('settlement input'),
      hash: Joi.string().guid().required().description('settlement-identifier')
    }).unknown(true)).required().description('publisher settlement report')
  },

  response:
    { schema: Joi.object().length(0) }
}

const v2 = {
  settlement: v2Settlement
}

const routes = [
  braveHapi.routes.async().post().path('/v2/publishers/settlement').config(v2.settlement)
]

const initialize = async (debug, runtime) => {
  altcurrency = runtime.config.altcurrency || 'BAT'

  await runtime.database.checkIndices(debug, [
    {
      category: runtime.database.get('publishers', debug),
      name: 'publishers',
      property: 'publisher',
      empty: {
        publisher: '',    // domain OR 'oauth#' + provider + ':' + (profile.id || profile._id)
        authority: '',

     // v1 only
     // authorized: false,
     // address: '',
     // legalFormURL: '',

        verified: false,
        visible: false,

     // v2 and later
        owner: '',

        providerName: '',
        providerSuffix: '',
        providerValue: '',
        authorizerEmail: '',
        authorizerName: '',

        altcurrency: '',

        info: {},

        timestamp: bson.Timestamp.ZERO
      },
      unique: [ { publisher: 1 } ],
      others: [ { authority: 1 },
                { owner: 1 },
                { providerName: 1 }, { providerSuffix: 1 }, { providerValue: 1 },
                { authorizerEmail: 1 }, { authorizerName: 1 },
                { altcurrency: 1 },
                { timestamp: 1 } ]
    },
    {
      category: runtime.database.get('settlements', debug),
      name: 'settlements',
      property: 'settlementId_1_publisher',
      empty: {
        settlementId: '',
        publisher: '',
        hash: '',
        address: '',

     // v1 only
     // satoshis: 1

     // v2 and later
        owner: '',
        altcurrency: '',
        probi: bson.Decimal128.POSITIVE_ZERO,
        fees: bson.Decimal128.POSITIVE_ZERO,          // processing fees
        currency: '',
        amount: bson.Decimal128.POSITIVE_ZERO,
        commission: bson.Decimal128.POSITIVE_ZERO,    // conversion fee (i.e., for settlement)
        fee: bson.Decimal128.POSITIVE_ZERO,           // network fee (i.e., for settlement)
        type: '',
        executedAt: new Date(0),              // When the settlement was executed
        timestamp: bson.Timestamp.ZERO
      },
      unique: [ { settlementId: 1, publisher: 1 }, { hash: 1, publisher: 1 } ],
      others: [ { address: 1 },
                { owner: 1 }, { altcurrency: 1 }, { probi: 1 }, { fees: 1 }, { currency: 1 }, { amount: 1 }, { commission: 1 },
                { fee: 1 }, { type: 1 }, { timestamp: 1 }, { executedAt: 1 } ]
    },
    {
      category: runtime.database.get('publishersV2', debug),
      name: 'publishersV2',
      property: 'publisher',
      empty: { publisher: '', facet: '', exclude: false, tags: [], timestamp: bson.Timestamp.ZERO },
      unique: [ { publisher: 1 } ],
      others: [ { facet: 1 }, { exclude: 1 }, { timestamp: 1 } ]
    }
  ])
}

export default {
  routes,
  initialize
}
