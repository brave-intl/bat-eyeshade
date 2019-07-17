#!/usr/bin/env node

const Database = require('bat-utils/lib/runtime-database')
const Queue = require('bat-utils/lib/runtime-queue')
const SDebug = require('sdebug')
const debug = new SDebug('migrate-transaction-table')

async function main () {
  const database = new Database({ database: process.env.MONGODB_URI })
  const queue = new Queue({ queue: process.env.REDIS_URL })

  // settlements

  const settlements = database.get('settlements', debug)
  const settlementIds = await settlements.distinct('settlementId')

  for (let settlementId of settlementIds) {
    if (settlementId) {
      await queue.send(debug, 'settlement-report', { settlementId })
    }
  }

  // referrals

  const referrals = database.get('referrals', debug)
  const transactionIds = await referrals.distinct('transactionId')

  for (let transactionId of transactionIds) {
    if (transactionId) {
      await queue.send(debug, 'referral-report', { transactionId })
    }
  }

  // contributions

  const surveyorsC = database.get('surveyors', debug)
  const surveyors = await surveyorsC.find({ surveyorType: 'contribution', frozen: true })

  for (let surveyor of surveyors) {
    const { surveyorId } = surveyor
    if (surveyorId) {
      await queue.send(debug, 'surveyor-frozen-report', { surveyorId })
    }
  }

  await database.db.close()
  await queue.quit()
}

main().then(result => {}).catch(e => {
  console.error(e)
})
