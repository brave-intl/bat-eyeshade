const uuidV5 = require('uuid/v5')
const Joi = require('@hapi/joi')
const anonize = require('node-anonize2-relic')
const boom = require('boom')
const bson = require('bson')
const timestamp = require('monotonic-timestamp')
const underscore = require('underscore')

const surveyorsLib = require('../lib/surveyor')
const {
  createComposite,
  promotionIdExclusions,
  promotionIdBonuses
} = require('../lib/wallet')

const utils = require('bat-utils')
const braveHapi = utils.extras.hapi
const braveJoi = utils.extras.joi
const braveUtils = utils.extras.utils
const { btoa, BigNumber } = braveUtils

const v1 = {}
const v2 = {}

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
   GET /v2/wallet/{paymentId}/info
 */
v2.readInfo = {
  handler: (runtime) => {
    return async (request, h) => {
      const debug = braveHapi.debug(module, request)
      const paymentId = request.params.paymentId.toLowerCase()

      let wallet
      if (runtime.config.forward.wallets) {
        const { payload } = await runtime.wreck.walletMigration.get(debug, `/v3/wallet/${paymentId}`)
        wallet = JSON.parse(payload.toString())
        const { walletProvider, publicKey, depositAccountProvider } = wallet
        wallet.httpSigningPubKey = publicKey
        wallet.provider = walletProvider.name
        if (walletProvider.name === 'uphold') {
          wallet.addresses = {
            CARD_ID: walletProvider.id
          }
          wallet.anonymousAddress = null
          wallet.providerId = walletProvider.id
        } else {
          if (depositAccountProvider !== null && depositAccountProvider !== undefined) {
            wallet.addresses = {
              CARD_ID: depositAccountProvider.id
            }
            wallet.anonymousAddress = depositAccountProvider.anonymousAddress
            wallet.providerLinkingId = depositAccountProvider.providerLinkingId
            wallet.providerId = depositAccountProvider.id
          }
        }
      } else {
        const wallets = runtime.database.get('wallets', debug)
        wallet = await wallets.findOne({ paymentId })
      }
      if (!wallet) {
        throw boom.notFound('no such wallet: ' + paymentId)
      }

      const infoKeys = ['addresses', 'altcurrency', 'provider', 'providerId', 'paymentId', 'httpSigningPubKey', 'anonymousAddress']
      return underscore.pick(wallet, infoKeys)
    }
  },
  description: 'Returns information about the wallet associated with the user',
  tags: ['api'],

  validate: {
    params: Joi.object().keys({
      paymentId: Joi.string().guid().required().description('identity of the wallet')
    }).unknown(true)
  },

  response: {
    schema: Joi.object().keys({
      altcurrency: Joi.string().optional().description('the wallet balance currency'),
      addresses: Joi.object().keys({
        BTC: braveJoi.string().altcurrencyAddress('BTC').optional().description('BTC address'),
        BAT: braveJoi.string().altcurrencyAddress('BAT').optional().description('BAT address'),
        CARD_ID: Joi.string().allow('').optional().description('Card id'),
        ETH: braveJoi.string().altcurrencyAddress('ETH').optional().description('ETH address'),
        LTC: braveJoi.string().altcurrencyAddress('LTC').optional().description('LTC address')
      })
    }).unknown(true)
  }
}

/*
   GET /v2/wallet/{paymentId}/members
 */
v2.readMembersInfo = {
  handler: (runtime) => {
    return async (request, h) => {
      const debug = braveHapi.debug(module, request)
      const wallets = runtime.database.get('wallets', debug)
      const members = runtime.database.get('members', debug)
      const paymentId = request.params.paymentId.toLowerCase()

      const wallet = await wallets.findOne({ paymentId })
      if (!wallet) {
        throw boom.notFound('no such wallet: ' + paymentId)
      }

      let walletsBelongingToUser
      if (wallet.providerLinkingId) {
        const clusteredInfo = await members.findOne({
          providerLinkingId: wallet.providerLinkingId
        })
        walletsBelongingToUser = await wallets.find({
          paymentId: {
            $in: clusteredInfo.paymentIds
          }
        })
      } else {
        walletsBelongingToUser = [wallet]
      }

      const infoKeys = ['addresses', 'altcurrency', 'provider', 'providerId', 'paymentId', 'httpSigningPubKey', 'anonymousAddress']
      return walletsBelongingToUser.map((wallet) => underscore.pick(wallet, infoKeys))
    }
  },
  description: 'Returns information about the wallets associated with the user',
  tags: ['api'],

  validate: {
    params: Joi.object().keys({
      paymentId: Joi.string().guid().required().description('identity of the wallet')
    }).unknown(true)
  },

  response: {
    schema: Joi.array().items(Joi.object().keys({
      altcurrency: Joi.string().optional().description('the wallet balance currency'),
      addresses: Joi.object().keys({
        BTC: braveJoi.string().altcurrencyAddress('BTC').optional().description('BTC address'),
        BAT: braveJoi.string().altcurrencyAddress('BAT').optional().description('BAT address'),
        CARD_ID: Joi.string().guid().optional().description('Card id'),
        ETH: braveJoi.string().altcurrencyAddress('ETH').optional().description('ETH address'),
        LTC: braveJoi.string().altcurrencyAddress('LTC').optional().description('LTC address')
      })
    }).unknown(true)).min(1)
  }
}

/*
   GET /v2/wallet/{paymentId}
 */

const read = function () {
  return async () => {
    throw boom.serverUnavailable()
  }
}

v2.read = {
  handler: (runtime) => { return read(runtime, 2) },
  description: 'Returns information about the wallet associated with the user',
  tags: ['api'],

  validate: {
    params: Joi.object().keys({
      paymentId: Joi.string().guid().required().description('identity of the wallet')
    }).unknown(true),
    query: Joi.object().keys({
      // FIXME since this amount is not in native probi - need some kind of sig fig limit
      amount: Joi.number().positive().optional().description('the payment amount in fiat currency if provied, otherwise the altcurrency'),
      balance: Joi.boolean().optional().default(false).description('return balance information'),
      currency: braveJoi.string().currencyCode().optional().description('the fiat currency'),
      altcurrency: braveJoi.string().altcurrencyCode().optional().description('the altcurrency of the requested transaction'),
      refresh: Joi.boolean().optional().default(false).description('return balance and transaction information')
    }).unknown(true)
  },

  response: {
    schema: Joi.object().keys({
      cardBalance: braveJoi.string().numeric().optional().description('the wallet balance less grants'),
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
        CARD_ID: Joi.string().allow('').optional().description('Card id'),
        ETH: braveJoi.string().altcurrencyAddress('ETH').optional().description('ETH address'),
        LTC: braveJoi.string().altcurrencyAddress('LTC').optional().description('LTC address')
      }),
      grants: Joi.array().optional().items(Joi.object().keys({
        type: Joi.string().allow('ugp', 'ads', 'android').default('ugp').description('the type of grant to use'),
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
  return async (request, h) => {
    const debug = braveHapi.debug(module, request)
    const paymentId = request.params.paymentId.toLowerCase()
    const signedTx = request.payload.signedTx
    const surveyorId = request.payload.surveyorId
    const viewingId = request.payload.viewingId
    const requestType = request.payload.requestType
    const surveyors = runtime.database.get('surveyors', debug)
    const viewings = runtime.database.get('viewings', debug)
    const wallets = runtime.database.get('wallets', debug)

    let result, state

    const wallet = await wallets.findOne({ paymentId: paymentId })
    if (!wallet) {
      throw boom.notFound('no such wallet: ' + paymentId)
    }

    const txn = JSON.parse(signedTx.octets)

    const surveyor = await surveyors.findOne({ surveyorId, surveyorType: 'contribution' })
    if (!surveyor) {
      throw boom.notFound('no such surveyor: ' + surveyorId)
    }
    if (!surveyor.active) {
      throw boom.resourceGone('cannot perform a contribution with an inactive surveyor')
    }

    const params = surveyor.payload.adFree
    const txnProbi = runtime.wallet.getTxProbi(wallet, txn)
    const totalVotes = txnProbi.dividedBy(params.probi).times(params.votes).round().toNumber()

    if (totalVotes < 1) {
      throw boom.rangeNotSatisfiable('Too low vote value for transaction. PaymentId: ' + paymentId)
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
      throw boom.badData(ex.toString())
    }

    if (!surveyor.cohorts) {
      if (surveyor.surveyors) { // legacy surveyor, no cohort support
        throw boom.resourceGone('cannot perform a contribution using a legacy surveyor')
      } else {
        // new contribution surveyor not yet populated with voting surveyors
        const errMsg = 'surveyor ' + surveyor.surveyorId + ' has 0 surveyors, but needed ' + totalVotes
        runtime.captureException(errMsg, { req: request })

        const resp = boom.serverUnavailable(errMsg)
        resp.output.headers['retry-after'] = '5'
        throw resp
      }
    }

    for (let i = 0; i < surveyorsLib.cohorts.length; i += 1) {
      const cohort = surveyorsLib.cohorts[i]
      const cohortSurveyors = surveyor.cohorts[cohort]
      if (totalVotes > cohortSurveyors.length) {
        const state = { payload: request.payload, result: result, votes: totalVotes, message: 'insufficient surveyors' }
        debug('wallet', state)

        const errMsg = 'surveyor ' + surveyor.surveyorId + ' has ' + cohortSurveyors.length + ' ' + cohort + ' surveyors, but needed ' + totalVotes
        runtime.captureException(errMsg, { req: request })

        const resp = boom.serverUnavailable(errMsg)
        resp.output.headers['retry-after'] = '5'
        throw resp
      }
    }

    if (!result) {
      result = await runtime.wallet.submitTx(wallet, txn, signedTx, {
        commit: true
      })
    }
    const totalFee = result.fee

    if (result.status !== 'accepted' && result.status !== 'pending' && result.status !== 'completed') {
      throw boom.badData(result.status)
    }

    const nonGrantVotes = totalVotes
    const nonGrantFee = totalFee
    const surveyorIds = underscore.shuffle(surveyor.cohorts.control).slice(0, totalVotes)

    const now = timestamp()
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

    const response = h.response(result)

    if (nonGrantVotes > 0) {
      const cohort = 'control'
      await runtime.queue.send(debug, 'contribution-report', underscore.extend({
        paymentId: paymentId,
        address: wallet.addresses[result.altcurrency],
        surveyorId: surveyorId,
        viewingId: viewingId,
        fee: nonGrantFee,
        votes: nonGrantVotes,
        cohort
      }, result))
      countVote(runtime, nonGrantVotes, {
        cohort
      })
    }
    return response
  }
}

function countVote (runtime, votes, labels) {
  runtime.prometheus.getMetric('votes_issued_counter').inc(labels, votes)
}

v2.write = {
  handler: (runtime) => { return write(runtime, 2) },
  description: 'Makes a contribution using the wallet associated with the user',
  tags: ['api'],

  validate: {
    params: Joi.object().keys({
      paymentId: Joi.string().guid().required().description('identity of the wallet')
    }).unknown(true),
    payload: Joi.object().keys({
      viewingId: Joi.string().guid().required().description('unique-identifier for voting'),
      surveyorId: Joi.string().required().description('the identity of the surveyor'),
      requestType: Joi.string().valid('httpSignature', 'bitcoinMultisig').required().description('the type of the request'),
      signedTx: Joi.required().description('signed transaction')
    }).unknown(true)
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
v2.lookup = {
  handler: (runtime) => {
    return async (request, h) => {
      const debug = braveHapi.debug(module, request)
      const publicKey = request.query.publicKey
      if (runtime.config.disable.wallets) {
        throw boom.serverUnavailable()
      }
      if (runtime.config.forward.wallets) {
        const url = `/v3/wallet/recover/${publicKey}`
        const { payload } = await runtime.wreck.walletMigration.get(debug, url)
        return {
          paymentId: JSON.parse(payload.toString()).paymentId
        }
      }
      const wallets = runtime.database.get('wallets', debug)
      const wallet = await wallets.findOne({ httpSigningPubKey: publicKey })
      if (!wallet) {
        throw boom.notFound('no such wallet with publicKey: ' + publicKey)
      }
      return {
        paymentId: wallet.paymentId
      }
    }
  },
  description: 'Lookup a wallet',
  tags: ['api'],

  validate: {
    query: Joi.object().keys({
      publicKey: Joi.string().hex().optional().description('the publickey of the wallet to lookup')
    }).unknown(true)
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

v2.getStats = {
  handler: getStats(singleDateQuery),

  auth: {
    strategy: 'simple-scoped-token',
    scope: ['global', 'stats'],
    mode: 'required'
  },

  description: 'Retrieves information about wallets',
  tags: ['api'],

  validate: {
    params: Joi.object().keys({
      from: Joi.date().iso().required().description('the date to query for'),
      until: Joi.date().iso().optional().description('the non inclusive date to query until')
    }).unknown(true)
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
  const endOfDay = new Date(+baseDate + DAY)
  const dateEnd = until ? new Date(until) : endOfDay
  return {
    _id: {
      $gte: bson.ObjectID.createFromTime(new Date(baseDate / 1000)),
      $lt: bson.ObjectID.createFromTime(new Date(dateEnd / 1000))
    },
    paymentId: {
      $nin: ['', null]
    }
  }
}

function defaultQuery () {
  return {
    paymentId: {
      $nin: ['', null]
    }
  }
}

function getStats (getQuery = defaultQuery) {
  return (runtime) => {
    return async (request, h) => {
      const debug = braveHapi.debug(module, request)
      const wallets = runtime.database.get('wallets', debug)

      const values = await wallets.aggregate([{
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

      return values.map(({
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

      function add (numbers) {
        return numbers.reduce((memo, number) => {
          return memo.plus(new BigNumber(number || 0))
        }, new BigNumber('0')).toString()
      }
    }
  }
}

const grantsTypeEnumValidator = Joi.string().allow('ugp', 'ads').description('grant types')
const paymentIdValidator = Joi.string().guid().required().description('identity of the wallet')
const amountBatValidator = braveJoi.string().numeric().description('an amount, in bat')
v1.walletGrantsInfo = {
  handler: walletGrantsInfoHandler,
  description: 'Returns information about the wallet\'s grants',
  tags: ['api'],

  validate: {
    params: Joi.object().keys({
      paymentId: paymentIdValidator,
      type: grantsTypeEnumValidator
    }).unknown(true)
  },

  response: {
    schema: Joi.object().keys({
      type: grantsTypeEnumValidator,
      amount: amountBatValidator,
      bonus: amountBatValidator,
      lastClaim: Joi.date().iso().allow(null).description('the last claimed grant')
    })
  }
}

/*
  POST /v2/wallet/{paymentId}/claim
*/

v2.claimWallet = {
  handler: claimWalletHandler,
  description: 'Claim anonymous wallets',
  tags: ['api'],
  validate: {
    payload: Joi.alternatives().try(
      Joi.object().keys({
        signedTx: Joi.required().description('signed transaction')
      }),
      Joi.object().keys({
        signedTx: Joi.required().description('signed transaction'),
        anonymousAddress: Joi.string().guid().description('anonymous address for payouts')
      })
    )
  },
  response: {
    schema: Joi.object().length(0)
  }
}

module.exports.compositeGrants = compositeGrants

module.exports.routes = [
  braveHapi.routes.async().path('/v2/wallet/{paymentId}/grants/{type}').config(v1.walletGrantsInfo),
  braveHapi.routes.async().path('/v2/wallet/stats/{from}/{until?}').whitelist().config(v2.getStats),
  braveHapi.routes.async().post().path('/v2/wallet/{paymentId}/claim').config(v2.claimWallet),
  braveHapi.routes.async().path('/v2/wallet/{paymentId}/info').config(v2.readInfo),
  braveHapi.routes.async().path('/v2/wallet/{paymentId}/members').config(v2.readMembersInfo),
  braveHapi.routes.async().path('/v2/wallet/{paymentId}').config(v2.read),
  braveHapi.routes.async().put().path('/v2/wallet/{paymentId}').config(v2.write),
  braveHapi.routes.async().path('/v2/wallet').config(v2.lookup)
]

module.exports.initialize = async (debug, runtime) => {
  await runtime.queue.create('contribution-report')
  await runtime.queue.create('wallet-report')
}

function claimWalletHandler (runtime) {
  return async (request, h) => {
    const debug = braveHapi.debug(module, request)
    const { params, payload } = request
    const { signedTx, anonymousAddress } = payload
    const { paymentId } = params
    const wallets = runtime.database.get('wallets', debug)
    const members = runtime.database.get('members', debug)

    if (runtime.config.disable.wallets) {
      throw boom.serverUnavailable()
    }

    if (runtime.config.forward.wallets) {
      try {
        await runtime.wreck.walletMigration.post(debug, `/v3/wallet/uphold/${paymentId}/claim`, {
          payload: {
            signedLinkingRequest: btoa(JSON.stringify(signedTx)),
            anonymousAddress
          }
        })
        return {}
      } catch (err) {
        if (!err.data) {
          debug('erred no data', err)
          throw err
        }
        debug('erred from wallet migration claim', err.data.payload.toString())
        throw err
      }
    }

    const wallet = await wallets.findOne({ paymentId })
    if (!wallet) {
      throw boom.notFound()
    }

    const txn = runtime.wallet.validateTxSignature(wallet, signedTx, {
      destinationValidator: braveJoi.string().guid(),
      minimum: 0
    })
    const { postedTx } = await runtime.wallet.submitTx(wallet, txn, signedTx, {
      commit: false
    })
    const {
      type,
      isMember,
      node = { user: { id: '' } }
    } = postedTx.destination
    const userId = node.user.id

    const providerLinkingId = uuidV5(userId || '', 'c39b298b-b625-42e9-a463-69c7726e5ddc')
    // check that where the transfer is going to is a card, that belongs to a member
    debug('linking-card', { providerLinkingId, paymentId, anonymousAddress })
    if (type !== 'card' || !isMember || !userId) {
      throw boom.forbidden()
    }
    // if wallet has already been claimed, don't tie wallet to member id
    if (wallet.providerLinkingId) {
      // Check if the member matches the associated member
      if (providerLinkingId !== wallet.providerLinkingId) {
        throw boom.forbidden()
      }

      if (anonymousAddress && (!wallet.anonymousAddress || anonymousAddress !== wallet.anonymousAddress)) {
        // allow for updating / setting the anonymous address even if already claimed
        await wallets.update({
          paymentId
        }, {
          $set: { anonymousAddress }
        })
      }
    } else {
      await members.update({ providerLinkingId }, {
        $set: {
          providerLinkingId
        }
      }, { upsert: true })
      // Attempt to associate the paymentId with the member, enforcing max associations no more than the default
      const defaultLimit = 4
      const limit = process.env.NODE_ENV !== 'production' ? +process.env.PER_MEMBER_CLAIM_LIMIT || defaultLimit : defaultLimit
      const member = await members.findOneAndUpdate({
        providerLinkingId,
        $expr: {
          $lt: [{
            $size: {
              $ifNull: ['$paymentIds', []]
            }
          }, limit]
        }
      }, {
        $push: {
          paymentIds: paymentId
        }
      })
      // If association worked, perform reverse association, providerLinkingId with wallet
      if (!member) {
        throw boom.conflict()
      }
      const toSet = { providerLinkingId }

      if (anonymousAddress) {
        underscore.extend(toSet, { anonymousAddress })
      }
      await wallets.update({
        paymentId
      }, {
        $set: toSet
      })
    }

    if (+txn.denomination.amount !== 0) {
      await runtime.wallet.submitTx(wallet, txn, signedTx, {
        commit: true
      })
    }

    return {}
  }
}

function walletGrantsInfoHandlerFWD (runtime) {
  return async (request, h) => {
    const debug = braveHapi.debug(module, request)
    try {
      let {
        res,
        payload
      } = await compositeGrantsFWD(debug, runtime, request.params)
      const { statusCode } = res
      payload = payload.toString()
      if (statusCode === 204) {
        return h.response({}).code(statusCode)
      }
      payload = JSON.parse(payload)
      if (statusCode === 200) {
        const { earnings, lastClaim, type } = payload
        return {
          lastClaim,
          type,
          amount: earnings
        }
      } else {
        throw boom.boomify(payload)
      }
    } catch (e) {
      throw boom.boomify(e)
    }
  }
}

async function compositeGrantsFWD (debug, runtime, {
  paymentId,
  type
}) {
  return runtime.wreck.grants.get(debug, `/v1/promotions/${type}/grants/summary`, {
    query: {
      paymentId,
      // just here until we swap it out
      // with the key above
      paymentID: paymentId
    }
  })
}
/*
  GET /v2/wallet/{paymentId}/grants/{type}
*/
function walletGrantsInfoHandler (runtime) {
  if (runtime.config.forward.grants) {
    return walletGrantsInfoHandlerFWD(runtime)
  }
  return async (request, h) => {
    const debug = braveHapi.debug(module, request)
    const {
      type,
      paymentId
    } = request.params
    try {
      const composite = await compositeGrants(debug, runtime, {
        type,
        paymentId
      })
      const status = composite.lastClaim ? 200 : 204
      return h.response(composite).code(status)
    } catch (e) {
      throw boom.boomify(e)
    }
  }
}

async function compositeGrants (debug, runtime, {
  paymentId,
  type: requiredType
}) {
  const wallets = runtime.database.get('wallets', debug)
  const wallet = await wallets.findOne({ paymentId }, { grants: 1 })
  if (!wallet) {
    throw boom.notFound('unable to find wallet')
  }
  const { grants = [] } = wallet
  let amount = new BigNumber(0)
  let lastClaim = null
  for (let i = grants.length - 1; i >= 0; i--) {
    const grant = grants[i]
    const { claimTimestamp, token, type } = grant
    if (requiredType === 'ugp') {
      if (type && type !== requiredType) {
        continue
      }
    } else if (type !== requiredType) {
      continue
    }
    const content = braveUtils.extractJws(token)
    const { probi } = content
    const { promotionId } = grant
    if (promotionIdExclusions[promotionId]) {
      continue
    }
    amount = amount.plus(probi)
    // remove bonuses
    const bonus = promotionIdBonuses[promotionId]
    if (bonus) {
      const bigBonus = (new BigNumber(bonus)).times(braveUtils.PROBI_FACTOR)
      amount = amount.minus(bigBonus)
    }
    const claimedAt = new Date(claimTimestamp)
    lastClaim = lastClaim > claimedAt ? lastClaim : claimedAt
  }
  return createComposite({
    type: requiredType,
    amount: amount.dividedBy(braveUtils.PROBI_FACTOR),
    lastClaim
  })
}
