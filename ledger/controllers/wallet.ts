import BigNumber from 'bignumber.js'
import Joi from 'joi'
import anonize from 'node-anonize2-relic'
import boom from 'boom'
import bson from 'bson'
import timestamp from 'monotonic-timestamp'
import underscore from 'underscore'
import surveyorsLib from '../lib/surveyor'
import utils from 'bat-utils'

const braveHapi = utils.extras.hapi
const braveJoi = utils.extras.joi
const braveUtils = utils.extras.utils

const walletStatsList = Joi.array().items(
  Joi.object().keys({
    created: Joi.string().required().description('date the wallets in this cohort were created'),
    wallets: Joi.number().required().description('the number of wallets created on this date'),
    contributed: Joi.number().required().description('the number of wallets created on this date that have a claimed grant that has not yet been redeemed'),
    walletProviderBalance: Joi.string().required().description('the balances of the wallets created on this day'),
    anyFunds: Joi.number().required().description('the number of wallets created on this date that have either an unredeemed grant or a wallet provider balance'),
    activeGrant: Joi.number().required().description('the number of wallets created on this date that have an active grant'),
    walletProviderFunded: Joi.number().required().description('the number of wallets that are currently funded')
  })
)

/*
   GET /v2/wallet/{paymentId}
 */

const read = function (runtime, apiVersion) {
  return async (request, reply) => {
    const amount = request.query.amount
    const balanceP = request.query.balance
    const debug = braveHapi.debug(module, request)
    const paymentId = request.params.paymentId.toLowerCase()
    const refreshP = request.query.refresh
    const wallets = runtime.database.get('wallets', debug)
    const altcurrency = request.query.altcurrency

    let currency = request.query.currency
    let balances, info, result, state, wallet, wallet2

    wallet = await wallets.findOne({ paymentId: paymentId })
    if (!wallet) return reply(boom.notFound('no such wallet: ' + paymentId))

    if (altcurrency && altcurrency !== wallet.altcurrency) {
      return reply(boom.badData('the altcurrency of the transaction must match that of the wallet'))
    }

    const subset = currency ? [currency.toUpperCase()] : null
    const rates = await runtime.currency.rates(wallet.altcurrency, subset)
    result = {
      altcurrency: wallet.altcurrency,
      paymentStamp: wallet.paymentStamp || 0,
      httpSigningPubKey: wallet.httpSigningPubKey,
      rates: underscore.mapObject(rates, (value) => +value)
    }

    result = underscore.extend(result, { addresses: wallet.addresses })
    if (runtime.registrars.persona) {
      result = underscore.extend(result, { parameters: runtime.registrars.persona.payload || {} })
    }

    if ((refreshP) || (balanceP && !wallet.balances)) {
      balances = await runtime.wallet.balances(wallet)

      if (!underscore.isEqual(balances, wallet.balances)) {
        state = { $currentDate: { timestamp: { $type: 'timestamp' } }, $set: { balances: balances } }
        await wallets.update({ paymentId: paymentId }, state, { upsert: true })

        await runtime.queue.send(debug, 'wallet-report', underscore.extend({ paymentId: paymentId }, state.$set))
        state = null
      }
    } else {
      balances = wallet.balances
    }
    if (balances) {
      let { grants } = wallet
      if (grants) {
        let active = await sumActiveGrants(runtime, null, wallet, grants)
        balances.confirmed = new BigNumber(balances.confirmed).plus(active.total)
        result.grants = active.grants
      }

      underscore.extend(result, {
        probi: balances.confirmed.toString(),
        balance: new BigNumber(balances.confirmed).dividedBy(runtime.currency.alt2scale(wallet.altcurrency)).toFixed(4),
        unconfirmed: new BigNumber(balances.unconfirmed).dividedBy(runtime.currency.alt2scale(wallet.altcurrency)).toFixed(4)
      })
    }

    if (amount) {
      if (refreshP) {
        if (currency) {
          try {
            await runtime.currency.ratio('USD', currency)
          } catch (e) {
            return reply(boom.notFound('no such currency: ' + currency))
          }
          const rates = await runtime.currency.rates(wallet.altcurrency)
          if (!rates || !rates[currency.toUpperCase()]) {
            const errMsg = `There is not yet a conversion rate for ${wallet.altcurrency} to ${currency.toUpperCase()}`
            const resp = boom.serverUnavailable(errMsg)
            resp.output.headers['retry-after'] = '5'
            return reply(resp)
          }
        } else if (altcurrency) {
          currency = altcurrency
        } else {
          return reply(boom.badData('must pass at least one of currency or altcurrency'))
        }
        result = underscore.extend(result, await runtime.wallet.unsignedTx(wallet, amount, currency, balances.confirmed))

        if (result.unsignedTx) {
          if (result.requestType === 'bitcoinMultisig') {
            state = {
              $currentDate: { timestamp: { $type: 'timestamp' } },
              $set: { unsignedTx: result.unsignedTx.transactionHex }
            }
          } else {
            state = {
              $currentDate: { timestamp: { $type: 'timestamp' } },
              $set: { unsignedTx: result.unsignedTx }
            }
          }
        }
      }

      info = await runtime.wallet.purchaseBAT(wallet, amount, currency, request.headers['accept-language'])
      wallet2 = info && info.extend && underscore.extend({}, info.extend, wallet)
      if ((wallet2) && (!underscore.isEqual(wallet, wallet2))) {
        if (!state) {
          state = {
            $currentDate: { timestamp: { $type: 'timestamp' } },
            $set: {}
          }
        }
        underscore.extend(state.$set, info.quotes)
      }
      underscore.extend(result, underscore.omit(info, [ 'quotes' ]))

      if (state) await wallets.update({ paymentId: paymentId }, state, { upsert: true })
    }

    reply(result)
  }
}

async function sumActiveGrants (runtime, info, wallet, grants) {
  let total = new BigNumber(0)
  const results = []
  for (let grant of grants) {
    let { token, status } = grant
    if (status !== 'active') {
      continue
    }
    if (await runtime.wallet.isGrantExpired(info, grant)) {
      await runtime.wallet.expireGrant(info, wallet, grant)
    } else {
      let content = braveUtils.extractJws(token)
      total = total.plus(content.probi)
      const exposedContent = underscore.pick(content, ['altcurrency', 'expiryTime', 'probi', 'type'])
      exposedContent.type = exposedContent.type || 'ugp'
      results.push(exposedContent)
    }
  }
  return {
    total,
    grants: results
  }
}

const v2Read = { handler: (runtime) => { return read(runtime, 2) },
  description: 'Returns information about the wallet associated with the user',
  tags: [ 'api' ],

  validate: {
    params: {
      paymentId: Joi.string().guid().required().description('identity of the wallet')
    },
    query: {
      // FIXME since this amount is not in native probi - need some kind of sig fig limit
      amount: Joi.number().positive().optional().description('the payment amount in fiat currency if provied, otherwise the altcurrency'),
      balance: Joi.boolean().optional().default(false).description('return balance information'),
      currency: braveJoi.string().currencyCode().optional().description('the fiat currency'),
      altcurrency: braveJoi.string().altcurrencyCode().optional().description('the altcurrency of the requested transaction'),
      refresh: Joi.boolean().optional().default(false).description('return balance and transaction information')
    }
  },

  response: {
    schema: Joi.object().keys({
      balance: Joi.number().min(0).optional().description('the (confirmed) wallet balance'),
      unconfirmed: Joi.number().min(0).optional().description('the unconfirmed wallet balance'),
      paymentStamp: Joi.number().min(0).required().description('timestamp of the last successful payment'),
      rates: Joi.object().pattern(/^[A-Z]{2,}$/i, Joi.number()).required().description('current exchange rates to various currencies'),
      probi: braveJoi.string().numeric().optional().description('the wallet balance in probi'),
      altcurrency: Joi.string().optional().description('the wallet balance currency'),
      requestType: Joi.string().valid('httpSignature', 'bitcoinMultisig').optional().description('the type of the request'),
      unsignedTx: Joi.object().optional().description('unsigned transaction'),
      addresses: Joi.object().keys({
        BTC: braveJoi.string().altcurrencyAddress('BTC').optional().description('BTC address'),
        BAT: braveJoi.string().altcurrencyAddress('BAT').optional().description('BAT address'),
        CARD_ID: Joi.string().guid().optional().description('Card id'),
        ETH: braveJoi.string().altcurrencyAddress('ETH').optional().description('ETH address'),
        LTC: braveJoi.string().altcurrencyAddress('LTC').optional().description('LTC address')
      }),
      grants: Joi.array().optional().items(Joi.object().keys({
        type: Joi.string().allow(['ugp', 'ads']).default('ugp').description('the type of grant to use'),
        probi: braveJoi.string().numeric().optional().description('the grant value in probi'),
        altcurrency: Joi.string().optional().description('the grant currency'),
        expiryTime: Joi.number().optional().description('unix timestamp when the grant expires')
      }))
    }).unknown(true)
  }
}

/*
   PUT /v2/wallet/{paymentId}
 */

const write = function (runtime, apiVersion) {
  return async (request, reply) => {
    const debug = braveHapi.debug(module, request)
    const paymentId = request.params.paymentId.toLowerCase()
    const signedTx = request.payload.signedTx
    const surveyorId = request.payload.surveyorId
    const viewingId = request.payload.viewingId
    const requestType = request.payload.requestType
    const surveyors = runtime.database.get('surveyors', debug)
    const viewings = runtime.database.get('viewings', debug)
    const wallets = runtime.database.get('wallets', debug)

    let now, params, result, state, surveyor, surveyorIds, wallet, txnProbi, grantCohort
    let totalFee, grantFee, nonGrantFee
    let totalVotes, grantVotes, nonGrantVotes

    wallet = await wallets.findOne({ paymentId: paymentId })
    if (!wallet) return reply(boom.notFound('no such wallet: ' + paymentId))

    const txn = JSON.parse(signedTx.octets)

    surveyor = await surveyors.findOne({ surveyorId, surveyorType: 'contribution' })
    if (!surveyor) return reply(boom.notFound('no such surveyor: ' + surveyorId))
    if (!surveyor.active) return reply(boom.resourceGone('cannot perform a contribution with an inactive surveyor'))

    params = surveyor.payload.adFree
    txnProbi = runtime.wallet.getTxProbi(wallet, txn)
    totalVotes = txnProbi.dividedBy(params.probi).times(params.votes).round().toNumber()

    if (totalVotes < 1) {
      return reply(boom.rangeNotSatisfiable('Too low vote value for transaction. PaymentId: ' + paymentId))
    }

    const minimum = surveyorsLib.voteValueFromSurveyor(runtime, surveyor, wallet.altcurrency)
    try {
      const info = underscore.extend(wallet, { requestType: requestType })
      runtime.wallet.validateTxSignature(info, signedTx, {
        minimum
      })
    } catch (ex) {
      debug('validateTxSignature', { reason: ex.toString(), stack: ex.stack })
      runtime.captureException(ex, { req: request, extra: { paymentId: paymentId } })
      return reply(boom.badData(ex.toString()))
    }

    if (!surveyor.cohorts) {
      if (surveyor.surveyors) { // legacy surveyor, no cohort support
        return reply(boom.resourceGone('cannot perform a contribution using a legacy surveyor'))
      } else {
        // new contribution surveyor not yet populated with voting surveyors
        const errMsg = 'surveyor ' + surveyor.surveyorId + ' has 0 surveyors, but needed ' + totalVotes
        runtime.captureException(errMsg, { req: request })

        const resp = boom.serverUnavailable(errMsg)
        resp.output.headers['retry-after'] = '5'
        return reply(resp)
      }
    }

    for (let cohort of surveyorsLib.cohorts) {
      const cohortSurveyors = surveyor.cohorts[cohort]

      if (totalVotes > cohortSurveyors.length) {
        state = { payload: request.payload, result: result, votes: totalVotes, message: 'insufficient surveyors' }
        debug('wallet', state)

        const errMsg = 'surveyor ' + surveyor.surveyorId + ' has ' + cohortSurveyors.length + ' ' + cohort + ' surveyors, but needed ' + totalVotes
        runtime.captureException(errMsg, { req: request })

        const resp = boom.serverUnavailable(errMsg)
        resp.output.headers['retry-after'] = '5'
        return reply(resp)
      }
    }

    try {
      result = await runtime.wallet.redeem(wallet, txn, signedTx, request)
    } catch (err) {
      let payload = err.data.payload
      payload = payload.toString()
      if (payload[0] === '{') {
        payload = JSON.parse(payload)
        let payloadData = payload.data
        if (payloadData) {
          await markGrantsAsRedeemed(payloadData.redeemedIDs)
        }
      }
      return reply(err)
    }

    if (!result) {
      result = await runtime.wallet.submitTx(wallet, txn, signedTx)
    }
    totalFee = result.fee

    if (result.status !== 'accepted' && result.status !== 'pending' && result.status !== 'completed') return reply(boom.badData(result.status))

    const grantIds = result.grantIds
    const grantTotal = result.grantTotal

    if (grantIds) { // some grants were redeemed
      await markGrantsAsRedeemed(grantIds)
      grantCohort = wallet.cohort || 'grant'
      let grantVotesAvailable = new BigNumber(grantTotal).dividedBy(params.probi).times(params.votes).round().toNumber()

      if (grantVotesAvailable >= totalVotes) { // more grant value was redeemed than the transaction value, all votes will be grant
        nonGrantVotes = 0
        nonGrantFee = 0
        grantVotes = totalVotes
        grantFee = totalFee
        surveyorIds = surveyor.cohorts[grantCohort].slice(0, grantVotes)
      } else { // some of the transaction value will be covered by grant
        grantVotes = grantVotesAvailable
        nonGrantVotes = totalVotes - grantVotes

        let grantProbiRate = grantTotal / txnProbi
        grantFee = totalFee * grantProbiRate
        nonGrantFee = totalFee - grantFee

        let grantSurveyorIds = surveyor.cohorts[grantCohort].slice(0, grantVotes)
        let nonGrantSurveyorIds = surveyor.cohorts['control'].slice(0, nonGrantVotes)
        surveyorIds = underscore.shuffle(grantSurveyorIds.concat(nonGrantSurveyorIds))
        result = underscore.omit(result, ['grantIds'])
      }
    } else { // no grants were used in the transaction
      grantVotes = 0
      grantFee = 0
      nonGrantVotes = totalVotes
      nonGrantFee = totalFee
      surveyorIds = underscore.shuffle(surveyor.cohorts['control']).slice(0, totalVotes)
    }

    now = timestamp()
    state = { $currentDate: { timestamp: { $type: 'timestamp' } }, $set: { paymentStamp: now } }
    await wallets.update({ paymentId: paymentId }, state, { upsert: true })

    state = {
      $currentDate: { timestamp: { $type: 'timestamp' } },
      $set: {
        surveyorId: surveyorId,
        uId: anonize.uId(viewingId),
        surveyorIds: surveyorIds,
        altcurrency: wallet.altcurrency,
        probi: result.probi,
        count: totalVotes
      }
    }
    await viewings.update({ viewingId: viewingId }, state, { upsert: true })

    const picked = ['votes', 'probi', 'altcurrency']
    result = underscore.extend({ paymentStamp: now }, underscore.pick(result, picked))

    reply(result)

    if (grantVotes > 0) {
      await runtime.queue.send(debug, 'contribution-report', underscore.extend({
        paymentId: paymentId,
        address: wallet.addresses[result.altcurrency],
        surveyorId: surveyorId,
        viewingId: viewingId,
        fee: grantFee,
        votes: grantVotes,
        cohort: grantCohort
      }, result))
    }

    if (nonGrantVotes > 0) {
      await runtime.queue.send(debug, 'contribution-report', underscore.extend({
        paymentId: paymentId,
        address: wallet.addresses[result.altcurrency],
        surveyorId: surveyorId,
        viewingId: viewingId,
        fee: nonGrantFee,
        votes: nonGrantVotes,
        cohort: 'control'
      }, result))
    }

    async function markGrantsAsRedeemed (grantIds) {
      await Promise.all(grantIds.map((grantId) => {
        const data = {
          $set: { 'grants.$.status': 'completed' }
        }
        const query = {
          paymentId,
          'grants.grantId': grantId
        }
        return wallets.update(query, data)
      }))
      await runtime.queue.send(debug, 'redeem-report', {
        grantIds,
        redeemed: true
      })
    }
  }
}

const v2Write = { handler: (runtime) => { return write(runtime, 2) },
  description: 'Makes a contribution using the wallet associated with the user',
  tags: [ 'api' ],

  validate: {
    params: { paymentId: Joi.string().guid().required().description('identity of the wallet') },
    payload: {
      viewingId: Joi.string().guid().required().description('unique-identifier for voting'),
      surveyorId: Joi.string().required().description('the identity of the surveyor'),
      requestType: Joi.string().valid('httpSignature', 'bitcoinMultisig').required().description('the type of the request'),
      signedTx: Joi.required().description('signed transaction')
    }
  },

  response: {
    schema: Joi.object().keys({
      paymentStamp: Joi.number().min(0).required().description('timestamp of the last successful contribution'),
      probi: braveJoi.string().numeric().description('the contribution amount in probi'),
      altcurrency: Joi.string().optional().description('the wallet balance currency'),
      votes: Joi.number().integer().min(0).optional().description('the corresponding number of publisher votes'),
      hash: Joi.string().hex().optional().description('transaction hash')
    })
  }
}

/*
   GET /v2/wallet
 */
const v2Lookup = { handler: (runtime) => {
  return async (request, reply) => {
    const debug = braveHapi.debug(module, request)
    const wallets = runtime.database.get('wallets', debug)
    const publicKey = request.query.publicKey
    const wallet = await wallets.findOne({ httpSigningPubKey: publicKey })
    if (!wallet) return reply(boom.notFound('no such wallet with publicKey: ' + publicKey))
    reply({ paymentId: wallet.paymentId })
  }
},
  description: 'Lookup a wallet',
  tags: [ 'api' ],

  validate: {
    query: {
      publicKey: Joi.string().hex().optional().description('the publickey of the wallet to lookup')
    }
  },

  response: {
    schema: Joi.object().keys({
      paymentId: Joi.string().guid().required().description('identity of the requested wallet')
    })
  }
}

/*
   GET /v2/wallet/stats/{from}/{until?}
 */

const v2GetStats = {
  handler: getStats(singleDateQuery),

  auth: {
    strategy: 'simple',
    mode: 'required'
  },

  description: 'Retrieves information about wallets',
  tags: [ 'api' ],

  validate: {
    params: {
      from: Joi.date().iso().required().description('the date to query for'),
      until: Joi.date().iso().optional().description('the non inclusive date to query until')
    }
  },
  response: {
    schema: walletStatsList
  }
}

function singleDateQuery ({
  params
}) {
  const {
    from,
    until
  } = params
  const baseDate = new Date(from)
  const DAY = 1000 * 60 * 60 * 24
  const endOfDay = +(new Date(+baseDate + DAY))
  const dateEnd = +(until ? new Date(until) : endOfDay)
  return {
    _id: {
      $gte: bson.ObjectID.createFromTime(new Date(+baseDate / 1000)),
      $lt: bson.ObjectID.createFromTime(new Date(dateEnd / 1000))
    },
    paymentId: {
      $nin: ['', null]
    }
  }
}

function defaultQuery (_) {
  return {
    paymentId: {
      $nin: ['', null]
    }
  }
}

function getStats (getQuery = defaultQuery) {
  return (runtime) => {
    return async (request, reply) => {
      const debug = braveHapi.debug(module, request)
      const wallets = runtime.database.get('wallets', debug)

      let values = await wallets.aggregate([{
        $match: getQuery(request)
      }, {
        $project: {
          _id: 0,
          walletProviderBalance: '$balances.balance',
          created: {
            $dateToString: {
              format: '%Y-%m-%d',
              date: '$_id'
            }
          },
          contributed: {
            $cond: {
              if: {
                $gt: ['$paymentStamp', 0]
              },
              then: 1,
              else: 0
            }
          },
          activeGrant: {
            $cond: {
              then: 1,
              else: 0,
              if: {
                $size: {
                  $filter: {
                    input: {
                      $ifNull: ['$grants', []]
                    },
                    as: 'grant',
                    cond: {
                      $eq: ['$$grant.status', 'active']
                    }
                  }
                }
              }
            }
          },
          walletProviderFunded: {
            $cond: {
              then: 1,
              else: 0,
              if: {
                $ne: ['$balances.confirmed', '0']
              }
            }
          }
        }
      }, {
        $project: {
          walletProviderBalance: 1,
          created: 1,
          contributed: 1,
          activeGrant: 1,
          walletProviderFunded: 1,
          anyFunds: {
            $cond: {
              then: 1,
              else: 0,
              if: {
                $or: [{
                  $gt: ['$walletProviderBalance', 0]
                }, {
                  $gt: ['$activeGrant', 0]
                }]
              }
            }
          }
        }
      }, {
        $group: {
          _id: '$created',
          walletProviderBalance: {
            $push: '$walletProviderBalance'
          },
          contributed: {
            $sum: '$contributed'
          },
          walletProviderFunded: {
            $sum: '$walletProviderFunded'
          },
          anyFunds: {
            $sum: '$anyFunds'
          },
          activeGrant: {
            $sum: '$activeGrant'
          },
          wallets: {
            $sum: 1
          }
        }
      }, {
        $project: {
          created: '$_id',
          wallets: 1,
          contributed: 1,
          walletProviderBalance: 1,
          anyFunds: 1,
          activeGrant: 1,
          walletProviderFunded: 1,
          _id: 0
        }
      }])

      values = values.map(({
        created,
        wallets,
        contributed,
        walletProviderBalance,
        anyFunds,
        activeGrant,
        walletProviderFunded
      }) => ({
        created,
        wallets,
        contributed,
        walletProviderBalance: add(walletProviderBalance),
        anyFunds,
        activeGrant,
        walletProviderFunded
      }))

      reply(values)

      function add (numbers) {
        return numbers.reduce((memo, number) => {
          return memo.plus(new BigNumber(number || 0))
        }, new BigNumber('0')).toString()
      }
    }
  }
}

const v2 = {
  getStats: v2GetStats,
  read: v2Read,
  write: v2Write,
  lookup: v2Lookup
}

const routes = [
  braveHapi.routes.async().path('/v2/wallet/stats/{from}/{until?}').whitelist().config(v2.getStats),
  braveHapi.routes.async().path('/v2/wallet/{paymentId}').config(v2.read),
  braveHapi.routes.async().put().path('/v2/wallet/{paymentId}').config(v2.write),
  braveHapi.routes.async().path('/v2/wallet').config(v2.lookup)
]

const initialize = async (debug, runtime) => {
  runtime.database.checkIndices(debug, [
    {
      category: runtime.database.get('wallets', debug),
      name: 'wallets',
      property: 'paymentId',
      empty: {
        paymentId: '',
        // v1
        // address: '',
        provider: '',
        balances: {},
        // v1
        // keychains: {},
        paymentStamp: 0,

     // v2 and later
        altcurrency: '',
        addresses: {},
        httpSigningPubKey: '',
        providerId: '',

        timestamp: bson.Timestamp.ZERO,
        grants: []
      },
      unique: [ { paymentId: 1 } ],
      others: [ { provider: 1 }, { altcurrency: 1 }, { paymentStamp: 1 }, { timestamp: 1 }, { httpSigningPubKey: 1 },
        { providerId: 1, 'grants.promotionId': 1 }
      ]
    },
    {
      category: runtime.database.get('viewings', debug),
      name: 'viewings',
      property: 'viewingId',
      empty: {
        viewingId: '',
        uId: '',
     // v1 only
     // satoshis: 0,

     // v2 and later
        altcurrency: '',
        probi: '0',

        count: 0,
        surveyorIds: [],
        timestamp: bson.Timestamp.ZERO
      },
      unique: [ { viewingId: 1 }, { uId: 1 } ],
      others: [ { altcurrency: 1 }, { probi: 1 }, { count: 1 }, { timestamp: 1 } ]
    }
  ])

  await runtime.queue.create('contribution-report')
  await runtime.queue.create('wallet-report')
}

export default {
  routes,
  initialize
}
