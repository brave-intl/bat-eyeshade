const bson = require('bson')

const {
  updateBalances,
  insertFromReferrals
} = require('./transaction')

module.exports = {
  getByTransactionIds,
  removeReferral,
  insertReferrals,
  insertReferral
}

async function getByTransactionIds (runtime, transactionIds) {
  const query = `
SELECT
  TX.document_id as "transactionId",
  TX.to_account as "ownerId",
  TX.channel as "channelId",
  amount
FROM transactions as TX
WHERE
  TX.document_id = any($1::text[]);`
  const {
    rows
  } = await runtime.postgres.query(query, [transactionIds])
  return rows
}

function removeReferral (runtime, transactionId) {
  const query = `
DELETE FROM transactions WHERE document_id = $1;`
  return runtime.postgres.query(query, [transactionId])
}

async function insertReferrals (runtime, options, referrals) {
  return runtime.postgres.transaction(async (client) => {
    const inserter = insertReferral(runtime, client, options)
    const result = await Promise.all(referrals.map(inserter))
    await updateBalances(runtime, client)
    return result
  })
}

function insertReferral (runtime, client, {
  probi,
  altcurrency,
  transactionId
}) {
  return ({
    channelId,
    ownerId
  }) => {
    const firstId = bson.ObjectID.createFromTime(new Date())
    const _id = {
      publisher: channelId,
      owner: ownerId,
      altcurrency: altcurrency || runtime.config.altcurrency || 'BAT'
    }
    return insertFromReferrals(runtime, client, {
      transactionId,
      firstId,
      probi,
      _id
    })
  }
}
