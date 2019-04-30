const BigNumber = require('bignumber.js')
const getPublisherProps = require('bat-publisher').getPublisherProps
const uuidv5 = require('uuid/v5')
const {
  createdTimestamp,
  normalizeChannel
} = require('bat-utils/lib/extras-utils')

const knownChains = {
  ETH: 'ethereum',
  BTC: 'bitcoin',
  LTC: 'litecoin'
}
const SETTLEMENT_NAMESPACE = {
  'contribution': '4208cdfc-26f3-44a2-9f9d-1f6657001706',
  'referral': '7fda9071-4f0d-4fe6-b3ac-b1c484d5601a',
  'manual': 'a7cb6b9e-b0b4-4c40-85bf-27a0172d4353'
}
module.exports = {
  knownChains: Object.assign({}, knownChains),
  insertTransaction,
  insertUserDepositFromChain,
  insertFromSettlement,
  insertFromVoting,
  insertFromReferrals,
  updateBalances,
  insertFromAd
}

async function insertTransaction (runtime, client, passed = {}, options = {}) {
  const {
    toTimestamp = true
  } = options
  let {
    id,
    createdAt,
    description,
    transactionType,
    documentId,
    fromAccount,
    fromAccountType,
    toAccount,
    toAccountType,
    amount,
    settlementCurrency = null,
    settlementAmount = null,
    channel = null
  } = passed

  if (!amount) {
    throw new Error('Missing amount field')
  }

  amount = new BigNumber(amount)
  if (amount.lessThanOrEqualTo(0)) {
    return [] // skip because we don't track tx's that don't have an accounting purpose
  }
  amount = amount.toString()

  const args = [ id, createdAt, description, transactionType, documentId, fromAccount, fromAccountType, toAccount, toAccountType, amount, settlementCurrency, settlementAmount, channel ]
  const $2 = toTimestamp ? 'to_timestamp($2)' : '$2'
  const query = `
INSERT INTO transactions ( id, created_at, description, transaction_type, document_id, from_account, from_account_type, to_account, to_account_type, amount, settlement_currency, settlement_amount, channel )
VALUES ( $1, ${$2}, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13 )
RETURNING *;
`
  try {
    const { rows } = await client.query(query, args)
    return rows
  } catch (e) {
    runtime.captureException(e, { inputs: passed })
    throw e
  }
}

async function insertUserDepositFromChain (runtime, client, chainDoc = {}) {
  let {
    id,
    amount,
    chain,
    cardId,
    createdAt,
    address
  } = chainDoc

  // using this so that we can pass in ticker / full name for now
  chain = knownChains[chain] || chain

  return insertTransaction(runtime, client, {
    id: uuidv5(`${chain}-${id}`, 'f7a8b983-2383-48f2-9e4f-717f6fe3225d'),
    createdAt: createdAt / 1000,
    description: `deposits from ${chain} chain`,
    transactionType: `user_deposit`,
    documentId: id,
    fromAccount: address,
    fromAccountType: chain,
    toAccount: cardId,
    toAccountType: 'uphold',
    amount: amount.toString()
  })
}

async function insertFromAd (runtime, client, {
  payment_id: paymentId,
  token_id: tokenId,
  amount
}) {
  const created = seconds()
  const { config } = runtime
  const id = uuidv5(`${paymentId}:${tokenId}`, '2ca02950-084f-475f-bac3-42a3c99dec95')
  const month = monthsFromSeconds(created)
  const options = {
    id,
    createdAt: created,
    description: `ad payments through ${month}`,
    transactionType: 'ad',
    documentId: tokenId,
    fromAccount: config.wallet.adsPayoutAddress.BAT,
    fromAccountType: 'uphold',
    toAccount: paymentId,
    toAccountType: 'payment_id',
    amount
  }
  return insertTransaction(runtime, client, options)
}

function monthsFromSeconds (created) {
  return new Date(created * 1000).toDateString().split(' ')[1]
}

function seconds () {
  return +(new Date()) / 1000
}

async function insertFromSettlement (runtime, client, settlement) {
  if (settlement.altcurrency !== 'BAT') {
    throw new Error('Only altcurrency === BAT transactions are supported')
  }
  const BATtoProbi = runtime.currency.alt2scale(settlement.altcurrency)

  if (settlement.probi && settlement.owner) {
    const probi = new BigNumber(settlement.probi.toString())
    const fees = new BigNumber(settlement.fees.toString())
    if (probi.greaterThan(new BigNumber(0))) {
      const normalizedChannel = normalizeChannel(settlement.publisher)
      const props = getPublisherProps(normalizedChannel)
      if (props.providerName && props.providerName === 'youtube' && props.providerSuffix === 'user') {
        throw new Error('Unexpected provider suffix: youtube#user')
      }
      const { executedAt } = settlement
      const created = executedAt ? new Date(executedAt) : createdTimestamp(settlement._id)
      const month = new Date(created).toDateString().split(' ')[1]

      if (settlement.type === 'contribution') {
        // channel -> owner for probi + fees, only applies to contributions
        await insertTransaction(runtime, client, {
          id: uuidv5(settlement.settlementId + normalizedChannel, 'eb296f6d-ab2a-489f-bc75-a34f1ff70acb'),
          createdAt: (created / 1000) - 2,
          description: `contributions through ${month}`,
          transactionType: 'contribution',
          documentId: settlement._id.toString(),
          fromAccount: normalizedChannel,
          fromAccountType: 'channel',
          toAccount: settlement.owner,
          toAccountType: 'owner',
          amount: probi.plus(fees).dividedBy(BATtoProbi).toString(),
          channel: normalizedChannel
        })

        // owner -> brave for fees, only applies to contributions
        if (fees.greaterThan(new BigNumber(0))) {
          await insertTransaction(runtime, client, {
            id: uuidv5(settlement.settlementId + normalizedChannel, '1d295e60-e511-41f5-8ae0-46b6b5d33333'),
            createdAt: (created / 1000) - 1,
            description: 'settlement fees',
            transactionType: 'fees',
            documentId: settlement._id.toString(),
            fromAccount: settlement.owner,
            fromAccountType: 'owner',
            toAccount: 'fees-account',
            toAccountType: 'internal',
            amount: fees.dividedBy(BATtoProbi).toString(),
            // settlementId and channel pair should be unique per settlement type
            channel: normalizedChannel
          })
        }
      } else if (settlement.type === 'manual') {
        // first insert the brave -> owner transaction
        await insertManual(runtime, client, settlement.settlementId, created, settlement.documentId, settlement.owner, settlement.probi)
      }
      // owner -> owner uphold for probi
      await insertTransaction(runtime, client, {
        id: uuidv5(settlement.settlementId + normalizedChannel, SETTLEMENT_NAMESPACE[settlement.type]),
        createdAt: (created / 1000),
        description: `payout for ${settlement.type}`,
        transactionType: `${settlement.type}_settlement`,
        documentId: settlement.type === 'manual' ? settlement.documentId : settlement._id.toString(),
        fromAccount: settlement.owner,
        fromAccountType: 'owner',
        toAccount: settlement.address,
        toAccountType: 'uphold',
        amount: probi.dividedBy(BATtoProbi).toString(),
        settlementCurrency: settlement.currency,
        settlementAmount: settlement.amount.toString(),
        channel: normalizedChannel
      })
    } else {
      throw new Error('Settlement probi must be greater than 0')
    }
  } else {
    throw new Error('Missing probi or owner field')
  }
}

async function insertManual (runtime, client, settlementId, created, documentId, toAccount, probi) {
  const description = 'handshake agreement with business developement'
  const transactionType = 'manual'
  const fromAccount = runtime.config.wallet.settlementAddress['BAT']
  const fromAccountType = 'uphold'
  const toAccountType = 'owner'

  const BATtoProbi = runtime.currency.alt2scale('BAT')
  const amountBAT = (new BigNumber(probi.toString())).dividedBy(BATtoProbi).toString()

  await insertTransaction(runtime, client, {
    id: uuidv5(settlementId + toAccount, '734a27cd-0834-49a5-8d4c-77da38cdfb22'),
    createdAt: created / 1000,
    description,
    transactionType,
    documentId,
    fromAccount,
    fromAccountType,
    toAccount,
    toAccountType,
    amount: amountBAT
  })
}

async function insertFromVoting (runtime, client, voteDoc, surveyorCreatedAt) {
  if (voteDoc.amount) {
    const amount = new BigNumber(voteDoc.amount.toString())
    const fees = new BigNumber(voteDoc.fees.toString())

    if (amount.greaterThan(new BigNumber(0))) {
      let normalizedChannel = normalizeChannel(voteDoc.channel)
      const props = getPublisherProps(normalizedChannel)
      if (props.providerName && props.providerName === 'youtube' && props.providerSuffix === 'user') {
        // skip for now
        return
      }
      await insertTransaction(runtime, client, {
        id: uuidv5(voteDoc.surveyorId + normalizedChannel, 'be90c1a8-20a3-4f32-be29-ed3329ca8630'),
        createdAt: surveyorCreatedAt,
        description: `votes from ${voteDoc.surveyorId}`,
        transactionType: 'contribution',
        documentId: voteDoc.surveyorId,
        fromAccount: runtime.config.wallet.settlementAddress['BAT'],
        fromAccountType: 'uphold',
        toAccount: normalizedChannel,
        toAccountType: 'channel',
        amount: amount.plus(fees).toString(),
        channel: normalizedChannel
      }, {
        toTimestamp: false
      })
    }
  } else {
    throw new Error('Missing amount field')
  }
}

async function insertFromReferrals (runtime, client, referrals) {
  if (referrals._id.altcurrency !== 'BAT') {
    throw new Error('Only altcurrency === BAT transactions are supported')
  }
  const BATtoProbi = runtime.currency.alt2scale(referrals._id.altcurrency)

  if (referrals.probi) {
    const probi = new BigNumber(referrals.probi.toString())
    const created = createdTimestamp(referrals.firstId)
    const month = new Date(created).toDateString().split(' ')[1]

    if (probi.greaterThan(new BigNumber(0))) {
      const normalizedChannel = normalizeChannel(referrals._id.publisher)
      const props = getPublisherProps(normalizedChannel)
      if (props.providerName && props.providerName === 'youtube' && props.providerSuffix === 'user') {
        throw new Error('Unexpected provider suffix: youtube#user')
      }
      await insertTransaction(runtime, client, {
        id: uuidv5(referrals.transactionId + normalizedChannel, '3d3e7966-87c3-44ed-84c3-252458f99536'),
        createdAt: created / 1000,
        description: `referrals through ${month}`,
        transactionType: 'referral',
        documentId: referrals.transactionId,
        fromAccount: runtime.config.wallet.settlementAddress[referrals._id.altcurrency],
        fromAccountType: 'uphold',
        toAccount: referrals._id.owner,
        toAccountType: 'owner',
        amount: probi.dividedBy(BATtoProbi).toString(),
        channel: normalizedChannel
      })
    }
  }
}

async function updateBalances (runtime, client, concurrently) {
  if (concurrently) {
    await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY account_balances')
  } else {
    await client.query('REFRESH MATERIALIZED VIEW account_balances')
  }
}
