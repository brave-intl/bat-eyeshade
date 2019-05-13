
import boom from 'boom'
import bson from 'bson'
import Joi from 'joi'
import underscore from 'underscore'

import utils from 'bat-utils'
const braveHapi = utils.extras.hapi
const braveJoi = utils.extras.joi

const schema = Joi.array().min(1).items(Joi.object().keys({
  ownerId: braveJoi.string().owner().required().description('the owner'),
  channelId: braveJoi.string().publisher().required().description('the publisher identity'),
  downloadId: Joi.string().guid().required().description('the download identity'),
  platform: Joi.string().token().required().description('the download platform'),
  finalized: Joi.date().iso().required().description('timestamp in ISO 8601 format').example('2018-03-22T23:26:01.234Z')
}).unknown(true)).required().description('list of finalized referrals')

let altcurrency

/*
   GET /v1/referrals/{transactionID}
 */

const v1FindReferrals = {
  handler: (runtime) => {
    return async (request, reply) => {
      const transactionId = request.params.transactionId
      const debug = braveHapi.debug(module, request)
      const transactions = runtime.database.get('referrals', debug)
      let entries, results

      entries = await transactions.find({ transactionId: transactionId })
      if (entries.length === 0) return reply(boom.notFound('no such transaction-identifier: ' + transactionId))

      results = []
      entries.forEach((entry) => {
        results.push(underscore.extend({ channelId: entry.publisher },
                                       underscore.pick(entry, [ 'downloadId', 'platform', 'finalized' ])))
      })
      reply(results)
    }
  },

  auth: {
    strategy: 'simple',
    mode: 'required'
  },

  description: 'Returns referral transactions for a publisher',
  tags: [ 'api', 'referrals' ],

  validate: {
    headers: Joi.object({ authorization: Joi.string().required() }).unknown(),
    params: {
      transactionId: Joi.string().guid().required().description('the transaction identity')
    }
  },

  response:
    { schema: schema }
}

/*
   PUT /v1/referrals/{transactionID}
       [ used by promo ]
 */

const v1CreateReferrals = {
  handler: (runtime) => {
    return async (request, reply) => {
      const transactionId = request.params.transactionId
      const payload = request.payload
      const debug = braveHapi.debug(module, request)
      const referrals = runtime.database.get('referrals', debug)
      const downloadIdsToBeConfirmed = []
      let entries, existingDownloadIds, probi

      probi = await runtime.currency.fiat2alt(runtime.config.referrals.currency, runtime.config.referrals.amount, altcurrency)
      probi = bson.Decimal128.fromString(probi.toString())

      // Get all download ids promo wants to finalize
      for (let referral of payload) {
        underscore.extend(referral, { altcurrency: altcurrency, probi: probi })
        downloadIdsToBeConfirmed.push(referral.downloadId)
      }

      // Check if any already are confirmed
      entries = await referrals.find({'downloadId': {$in: downloadIdsToBeConfirmed}})

      // Find which downloadIds are already accounted for
      existingDownloadIds = []
      if (entries.length > 0) {
        entries.forEach((referral) => { existingDownloadIds.push(referral.downloadId) })
      }

      for (let referral of payload) {
        let state

        // Don't insert referrals already accounted for
        if (existingDownloadIds.includes(referral.downloadId)) {
          continue
        }

        underscore.extend(referral, { altcurrency: altcurrency, probi: probi })
        state = {
          $currentDate: { timestamp: { $type: 'timestamp' } },
          $set: underscore.extend({
            finalized: new Date(referral.finalized),
            owner: referral.ownerId,
            publisher: referral.channelId,
            transactionId: transactionId,
            exclude: false
          }, underscore.pick(referral, [ 'platform', 'altcurrency', 'probi' ]))
        }
        await referrals.update({ downloadId: referral.downloadId }, state, { upsert: true })
      }

      await runtime.queue.send(debug, 'referral-report', { transactionId, shouldUpdateBalances: true })

      reply({})
    }
  },

  auth: {
    strategy: 'simple',
    mode: 'required'
  },

  description: 'Records referral transactions for a publisher',
  tags: [ 'api', 'referrals' ],

  validate: {
    headers: Joi.object({ authorization: Joi.string().required() }).unknown(),
    params: {
      transactionId: Joi.string().guid().required().description('the transaction identity')
    },
    payload: schema
  },

  response:
    { schema: Joi.object().length(0) }
}

const v1 = {
  findReferrals: v1FindReferrals,
  createReferrals: v1CreateReferrals
}

const routes = [
  braveHapi.routes.async().path('/v1/referrals/{transactionId}').whitelist().config(v1.findReferrals),
  braveHapi.routes.async().put().path('/v1/referrals/{transactionId}').whitelist().config(v1.createReferrals)
]

const initialize = async (debug, runtime) => {
  altcurrency = runtime.config.altcurrency || 'BAT'

  await runtime.database.checkIndices(debug, [
    {
      category: runtime.database.get('referrals', debug),
      name: 'referrals',
      property: 'downloadId',
      empty: {
        downloadId: '',

        transactionId: '',
        publisher: '',
        owner: '',
        platform: '',
        finalized: bson.Timestamp.ZERO,

        altcurrency: '',
        probi: bson.Decimal128.POSITIVE_ZERO,

     // added by administrator
        exclude: false,
        hash: '',

        timestamp: bson.Timestamp.ZERO
      },
      unique: [ { downloadId: 1 } ],
      others: [ { transactionId: 1 }, { publisher: 1 }, { owner: 1 }, { finalized: 1 },
                { altcurrency: 1 }, { probi: 1 }, { exclude: 1 }, { hash: 1 }, { timestamp: 1 },
                { altcurrency: 1, probi: 1 },
                { altcurrency: 1, exclude: 1, probi: 1 },
                { owner: 1, altcurrency: 1, exclude: 1, probi: 1 },
                { publisher: 1, altcurrency: 1, exclude: 1, probi: 1 } ]
    }
  ])
}

export default {
  routes,
  initialize
}
