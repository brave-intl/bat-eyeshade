import Joi from 'joi'
import batPublisher from 'bat-publisher'
import boom from 'boom'
import utils from 'bat-utils'
import BigNumber from 'bignumber.js'
import _ from 'underscore'
import queries from '../lib/queries'
import transactions from '../lib/transaction'

const { getPublisherProps } = batPublisher
const { normalizeChannel } = utils.extras.utils
const braveHapi = utils.extras.hapi
const braveJoi = utils.extras.joi

const settlementDestinationTypes = ['uphold']
const accountTypes = ['channel', 'owner'].concat(settlementDestinationTypes)
const transactionTypes = ['contribution', 'referral', 'contribution_settlement', 'referral_settlement', 'fees', 'scaleup', 'manual', 'user_deposit', 'manual_payout']

const accountTypeValidation = Joi.string().valid(accountTypes)
const orderParam = Joi.string().valid('asc', 'desc').optional().default('desc').description('order')
const joiChannel = Joi.string().description('The channel that earned or paid the transaction')
const joiPaid = Joi.number().description('amount paid out in BAT')

const selectAccountBalances = `
SELECT *
FROM account_balances
WHERE account_id = any($1::text[]);
`
const selectPendingAccountVotes = `
SELECT
  channel,
  SUM(votes.tally * surveyor.price)::TEXT as balance
FROM votes, (
  SELECT id, price
  FROM surveyor_groups
  WHERE NOT surveyor_groups.frozen
) surveyor
WHERE
    votes.surveyor_id = surveyor.id
AND votes.channel = any($1::text[])
AND NOT votes.transacted
AND NOT votes.excluded
GROUP BY channel;
`
/*
   GET /v1/accounts/{account}/transactions
*/

const v1GetTransactions =
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
      const omitted = _.omit(tx, (value) => value == null)
      return Object.assign({ channel: '' }, omitted)
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
    params: {
      account: Joi.alternatives().try(
        braveJoi.string().owner(),
        Joi.string().guid()
      ).required().description('the owner identity')
    }
  },

  response: {
    schema: Joi.array().items(Joi.object().keys({
      created_at: Joi.date().iso().required().description('when the transaction was created'),
      description: Joi.string().required().description('description of the transaction'),
      channel: Joi.alternatives().try(
        braveJoi.string().publisher().required().description('channel transaction is for'),
        Joi.string().default('').allow(['']).description('empty string returned')
      ),
      amount: Joi.number().required().description('amount in BAT'),
      settlement_currency: braveJoi.string().anycurrencyCode().optional().description('the fiat of the settlement'),
      settlement_amount: Joi.number().optional().description('amount in settlement_currency'),
      settlement_destination_type: Joi.string().optional().valid(settlementDestinationTypes).description('type of address settlement was paid to'),
      settlement_destination: Joi.string().optional().description('destination address of the settlement'),
      transaction_type: Joi.string().valid(transactionTypes).required().description('type of the transaction')
    }))
  }
}

/*
   GET /v1/accounts/balances/{type}/top
*/

const v1GetTopBalances =
{ handler: (runtime) => {
  return async (request, reply) => {
    let { limit } = request.query
    const { type } = request.params

    const query1 = `SELECT *
    FROM account_balances
    WHERE account_type = $1::text
    ORDER BY balance DESC
    LIMIT $2;`

    const transactions = await runtime.postgres.query(query1, [ type, limit ])
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
    params: Joi.object().keys({
      type: accountTypeValidation.required().description('balance types to retrieve')
    }),
    query: {
      limit: Joi.number().min(1).default(10).description('the top balances to retrieve')
    }
  },

  response: {
    schema: Joi.array().items(
      Joi.object().keys({
        account_id: Joi.string(),
        account_type: accountTypeValidation,
        balance: Joi.number().description('balance in BAT')
      })
    )
  }
}

/*
   GET /v1/accounts/balances
*/

const v1GetBalances = {
  handler: (runtime) => async (request, reply) => {
    let {
      account: accounts,
      pending: includePending
    } = request.query
    if (!accounts) {
      return reply(boom.badData())
    }

    if (!Array.isArray(accounts)) {
      accounts = [accounts]
    }
    accounts = accounts.map((account) => normalizeChannel(account))
    const args = [accounts]
    const checkVotes = includePending && (accounts
      .find((account) => {
        // provider name is known as publishers
        // on brave-intl/publishers's server
        const props = getPublisherProps(account)
        return props.providerName !== 'publishers'
      }))

    const votesPromise = checkVotes ? runtime.postgres.query(selectPendingAccountVotes, args) : {
      rows: []
    }
    const balancePromise = runtime.postgres.query(selectAccountBalances, args)
    const promises = [votesPromise, balancePromise]
    const results = await Promise.all(promises)

    const votesRows = results[0].rows
    const balanceRows = results[1].rows
    const body = votesRows.reduce(mergeVotes, balanceRows)

    reply(body)
  },

  auth: {
    strategy: 'simple-scoped-token',
    scope: ['publishers'],
    mode: 'required'
  },

  description: 'Used by publishers for retrieving a list of balances e.g. for an owner and their channels',

  tags: [ 'api', 'publishers' ],

  validate: {
    query: {
      pending: Joi.boolean().default(false).description('whether or not a query should be done for outstanding votes'),
      account: Joi.alternatives().try(
        Joi.string().description('account (channel or owner)'),
        Joi.array().items(Joi.string().required().description('account (channel or owner)'))
      ).required()
    }
  },

  response: {
    schema: Joi.array().items(
       Joi.object().keys({
         account_id: Joi.string(),
         account_type: Joi.string().valid(accountTypes),
         balance: Joi.number().description('balance in BAT')
       })
     )
  }
}

function mergeVotes (_memo, {
  channel: accountId,
  balance: voteBalance
}) {
  let memo = _memo
  const found = _.findWhere(memo, {
    account_id: accountId
  })
  if (found) {
    const amount = new BigNumber(found.balance)
    const balance = amount.plus(voteBalance).toString()
    Object.assign(found, {
      balance
    })
  } else {
    memo = memo.concat([{
      account_id: accountId,
      account_type: 'channel',
      balance: voteBalance
    }])
  }
  return memo
}

/*
   GET /v1/accounts/earnings/{type}/total
*/

const v1GetEarningsTotals =
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

const v1GetPaidTotals =
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
const v1AdTransactions = {
  handler: (runtime) => async (request, reply) => {
    const {
      params,
      payload
    } = request
    const { postgres } = runtime
    const { amount } = payload

    if (typeof process.env.ENABLE_ADS_PAYOUT === 'undefined') {
      return reply(boom.serverUnavailable())
    }
    if (amount <= 0) {
      return reply(boom.badData('amount must be greater than 0'))
    }

    try {
      await transactions.insertFromAd(runtime, postgres, Object.assign({}, params, { amount }))
      reply({})
    } catch (e) {
      if (e.code && e.code === '23505') { // Unique constraint violation
        reply(boom.conflict('Transaction with that id exists, updates are not allowed'))
      } else {
        throw e
      }
    }
  },
  auth: {
    strategy: 'simple-scoped-token',
    scope: ['ads'],
    mode: 'required'
  },

  description: 'Used by ads serve for scheduling an ad viewing payout',
  tags: [ 'api', 'ads' ],

  validate: {
    params: {
      payment_id: Joi.string().required().description('The payment id to hold the transaction under'),
      token_id: Joi.string().required().description('A unique token id')
    },
    payload: Joi.object().keys({
      amount: braveJoi.string().numeric().required().description('Amount of bat to pay for the ad')
    }).required()
  },

  response: { schema: Joi.object().length(0) }
}

const v1 = {
  getEarningsTotals: v1GetEarningsTotals,
  getPaidTotals: v1GetPaidTotals,
  getTopBalances: v1GetTopBalances,
  getBalances: v1GetBalances,
  adTransactions: v1AdTransactions,
  getTransactions: v1GetTransactions
}

const routes = [
  braveHapi.routes.async().path('/v1/accounts/earnings/{type}/total').whitelist().config(v1.getEarningsTotals),
  braveHapi.routes.async().path('/v1/accounts/settlements/{type}/total').whitelist().config(v1.getPaidTotals),
  braveHapi.routes.async().path('/v1/accounts/balances/{type}/top').whitelist().config(v1.getTopBalances),
  braveHapi.routes.async().path('/v1/accounts/balances').whitelist().config(v1.getBalances),
  braveHapi.routes.async().put().path('/v1/accounts/{payment_id}/transactions/ads/{token_id}').whitelist().config(v1.adTransactions),
  braveHapi.routes.async().path('/v1/accounts/{account}/transactions').whitelist().config(v1.getTransactions)
]

export default {
  routes,
  v1
}
