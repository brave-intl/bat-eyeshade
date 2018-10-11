const Joi = require('joi')
const boom = require('boom')
const BigNumber = require('bignumber.js')
const utils = require('bat-utils')
const _ = require('underscore')
const queries = require('../lib/queries')
const transactions = require('../lib/transaction')
const braveHapi = utils.extras.hapi
const braveJoi = utils.extras.joi

const v1 = {}

const orderParam = Joi.string().valid('asc', 'desc').optional().default('desc').description('order')
const joiChannel = Joi.string().description('The channel that earned or paid the transaction')
const joiPaid = Joi.number().description('amount paid out in BAT')

/*
   GET /v1/accounts/{account}/transactions
*/

v1.getTransactions =
{ handler: (runtime) => {
  return async (request, reply) => {
    const account = request.params.account
    const query1 = `select
  created_at,
  description,
  channel,
  amount,
  settlement_currency,
  settlement_amount,
  settlement_destination_type,
  settlement_destination,
  transaction_type
from account_transactions
where account_id = $1
ORDER BY created_at
`

    const result = await runtime.postgres.query(query1, [ account ])
    const transactions = result.rows

    const txs = _.map(transactions, (tx) => {
      return _.omit(tx, (value) => value == null)
    })

    reply(txs)
  }
},

  auth: {
    strategy: 'simple-scoped-token',
    scope: ['publishers'],
    mode: 'required'
  },

  description: 'Used by publishers for retrieving a list of transactions for use in statement generation, graphical dashboarding and filtering, etc.',
  tags: [ 'api', 'publishers' ],

  validate: {
    params: { account:
      braveJoi.string().owner().required().description('the owner identity')
    }
  },

  response: {
    schema: Joi.array().items(Joi.object().keys({
      created_at: Joi.date().iso().required().description('when the transaction was created'),
      description: Joi.string().required().description('description of the transaction'),
      channel: braveJoi.string().publisher().required().description('channel transaction is for'),
      amount: Joi.number().required().description('amount in BAT'),
      settlement_currency: braveJoi.string().anycurrencyCode().optional().description('the fiat of the settlement'),
      settlement_amount: Joi.number().optional().description('amount in settlement_currency'),
      settlement_destination_type: Joi.string().optional().valid(['uphold']).description('type of address settlement was paid to'),
      settlement_destination: Joi.string().optional().description('destination address of the settlement'),
      transaction_type: Joi.string().valid(['contribution', 'referral', 'contribution_settlement', 'referral_settlement', 'fees', 'scaleup', 'manual']).required().description('type of the transaction')
    }))
  }
}

/*
   GET /v1/accounts/balances
*/

v1.getBalances =
{ handler: (runtime) => {
  return async (request, reply) => {
    let accounts = request.query.account
    if (!accounts) return reply(boom.badData())

    if (!Array.isArray(accounts)) {
      accounts = [accounts]
    }

    const query1 = `select * from account_balances where account_id = any($1::text[])`

    const transactions = await runtime.postgres.query(query1, [ accounts ])
    reply(transactions.rows)
  }
},

  auth: {
    strategy: 'simple-scoped-token',
    scope: ['publishers'],
    mode: 'required'
  },

  description: 'Used by publishers for retrieving a list of balances e.g. for an owner and their channels',

  tags: [ 'api', 'publishers' ],

  validate: {
    query: { account: Joi.alternatives().try(
      Joi.string().description('account (channel or owner)'),
      Joi.array().items(Joi.string().required().description('account (channel or owner)'))
    ).required()}
  },

  response: {
    schema: Joi.array().items(
       Joi.object().keys({
         account_id: Joi.string(),
         account_type: Joi.string().valid(['channel', 'owner', 'uphold']),
         balance: Joi.number().description('balance in BAT')
       })
     )
  }
}

/*
   GET /v1/accounts/earnings/{type}/total
*/

v1.getEarningsTotals =
{ handler: (runtime) => {
  return async (request, reply) => {
    let { type } = request.params
    let {
      order,
      limit
    } = request.query

    if (type === 'contributions') {
      type = 'contribution'
    } else if (type === 'referrals') {
      type = 'referral'
    } else {
      return reply(boom.badData('type must be contributions or referrals'))
    }

    const query1 = queries.earnings({
      asc: order === 'asc'
    })

    const amounts = await runtime.postgres.query(query1, [type, limit])
    reply(amounts.rows)
  }
},

  auth: {
    strategy: 'simple-scoped-token',
    scope: ['publishers'],
    mode: 'required'
  },

  description: 'Used by publishers for retrieving a list of top channel earnings',

  tags: [ 'api', 'publishers' ],

  validate: {
    params: {
      type: Joi.string().valid('contributions', 'referrals').required().description('type of earnings')
    },
    query: {
      limit: Joi.number().positive().optional().default(100).description('limit the number of entries returned'),
      order: orderParam
    }
  },

  response: {
    schema: Joi.array().items(
       Joi.object().keys({
         channel: Joi.string(),
         earnings: Joi.number().description('earnings in BAT'),
         account_id: Joi.string()
       })
     )
  }
}

/*
   GET /v1/accounts/settlements/{type}/total
*/

v1.getPaidTotals =
{ handler: (runtime) => {
  return async (request, reply) => {
    let { type } = request.params
    let {
      order,
      limit
    } = request.query

    if (type === 'contributions') {
      type = 'contribution_settlement'
    } else if (type === 'referrals') {
      type = 'referral_settlement'
    } else {
      return reply(boom.badData('type must be contributions or referrals'))
    }

    const query1 = queries.settlements({
      asc: order === 'asc'
    })

    const amounts = await runtime.postgres.query(query1, [type, limit])
    reply(amounts.rows)
  }
},

  auth: {
    strategy: 'simple-scoped-token',
    scope: ['publishers'],
    mode: 'required'
  },

  description: 'Used by publishers for retrieving a list of top channels paid out',

  tags: [ 'api', 'publishers' ],

  validate: {
    params: {
      type: Joi.string().valid('contributions', 'referrals').required().description('type of payout')
    },
    query: {
      limit: Joi.number().positive().optional().default(100).description('limit the number of entries returned'),
      order: orderParam
    }
  },

  response: {
    schema: Joi.array().items(
       Joi.object().keys({
         channel: joiChannel.required(),
         paid: joiPaid.required(),
         account_id: Joi.string()
       })
     )
  }
}

/*
  PUT /v1/accounts/{payment_id}/transactions/ads/{token_id}
*/
v1.adTransactions = {
  handler: (runtime) => async (request, reply) => {
    const {
      params,
      payload
    } = request
    const {
      postgres
    } = runtime
    const {
      amount: payloadAmount
    } = payload
    if (!_.isString(payloadAmount)) {
      return reply(boom.badRequest())
    }
    const amount = (new BigNumber(payloadAmount)).toString()
    const tx = _.assign({}, params, {
      amount
    })
    let txs = null
    try {
      txs = await transactions.insertFromAd(runtime, postgres, tx)
    } catch (e) {
      const text = 'Transaction with that id exists, updates are not allowed'
      return reply(boom.conflict(text))
    }
    const transaction = txs[0]
    const result = {
      channel: transaction.channel,
      paid: transaction.amount
    }
    reply(result)
  },
  auth: {
    strategy: 'simple',
    mode: 'required'
  },

  description: 'Used by publishers for retrieving a list of top channels paid out',
  tags: [ 'api', 'publishers' ],

  validate: {
    params: {
      payment_id: Joi.string().required().description('The payment id to hold the transaction under'),
      token_id: Joi.string().required().description('A unique token id')
    },
    payload: Joi.object().keys({
      amount: Joi.string().regex(/^\d*\.?\d+/i).required().description('Amount of bat to pay for the ad')
    }).required()
  },

  response: {
    schema: Joi.object().keys({
      channel: joiChannel.required(),
      paid: joiPaid.required()
    }).required().description('Transaction inserted result')
  }
}

module.exports.routes = [
  braveHapi.routes.async().path('/v1/accounts/earnings/{type}/total').whitelist().config(v1.getEarningsTotals),
  braveHapi.routes.async().path('/v1/accounts/settlements/{type}/total').whitelist().config(v1.getPaidTotals),
  braveHapi.routes.async().path('/v1/accounts/balances').whitelist().config(v1.getBalances),
  braveHapi.routes.async().put().path('/v1/accounts/{payment_id}/transactions/ads/{token_id}').whitelist().config(v1.adTransactions),
  braveHapi.routes.async().path('/v1/accounts/{account}/transactions').whitelist().config(v1.getTransactions)
]

module.exports.v1 = v1
