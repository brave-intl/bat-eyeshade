'use strict'

import {
  serial as test
} from 'ava'
import uuidV4 from 'uuid/v4'
import {
  cleanDbs,
  serverContext
} from '../utils'
import { monthly } from '../../eyeshade/workers/ads'

test.before(serverContext)
test.afterEach.always(cleanDbs)

test('ads payout report cron job takes a snapshot of balances', async t => {
  const ledgerMongo = runtime.database
  const wallets = ledgerMongo.get('wallets', {})

  // Create the wallet that will receive payment
  const paymentId = uuidV4()
  const providerId = uuidV4()
  await wallets.insert({paymentId, providerId})
  const insertedWallet = await wallets.findOne({paymentId: paymentId})
  console.log('inserted wallet is')
  console.log(insertedWallet)

  // Create an ad transaction so there is a payment_id with a balance
  const txId = uuidV4()
  const createdAt = new Date()
  const description = 'funding tx for viewing ads'
  const transactionType = 'ad'
  const fromAccountType = 'uphold'
  const fromAccount = uuidV4()
  const toAccountType = 'payment_id'
  const amount = 1000

  const insertQuery = `insert into transactions (id, created_at, description, transaction_type, from_account_type, from_account, to_account_type, to_account, amount) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`
  await postgres.query(insertQuery, [txId, createdAt, description, transactionType, fromAccountType, fromAccount, toAccountType, paymentId, amount])

  // Refresh the account balances materialized view so the balance filters through
  await postgres.query(`refresh materialized view account_balances`)

  await monthly({}, runtime)

  // Ensure the wallet balance made it in
  const potentialPayments = (await postgres.query(`select * from potential_payments_ads`)).rows
  t.is(potentialPayments.length, 1, 'the correct number of payments were inserted')

  const potentialPayment = potentialPayments[0]
  t.is(potentialPayment.payment_id, paymentId, 'the inserted payment id matches')
  t.is(potentialPayment.provider_id, providerId, 'the inserted provider id matches')
  t.is(potentialPayment.amount, '1000.000000000000000000', 'the inserted amount matches')
})
