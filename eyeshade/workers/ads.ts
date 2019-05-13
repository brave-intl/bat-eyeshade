import cron from 'cron-parser'
import uuidV4 from 'uuid/v4'
import underscore from 'underscore'

const createPayoutReportQuery = `insert into payout_reports_ads (id) values ($1)`

const selectWalletBalancesQuery = `select account_id, balance from account_balances where account_type = 'payment_id'`

const createPotentialPaymentsQuery = `insert into potential_payments_ads (payout_report_id, payment_id, provider_id, amount) values ($1, $2, $3, $4)`

// Takes a snapshot of ad account balances
// and inserts them into potential_payments
const monthly = async (debug, runtime) => {
  const client = await runtime.postgres.connect()
  const walletsCollection = runtime.database.get('wallets', debug)
  const payoutReportId = uuidV4()

  try {
    await client.query('BEGIN')
    // First create the payout report
    await client.query(createPayoutReportQuery, [payoutReportId])
    // Next get all the payment_id, balance pairs for all the wallets
    const walletBalances = (await client.query(selectWalletBalancesQuery, [])).rows
    // Now insert the balance snapshots as potential ads payments
    for (let walletBalance of walletBalances) {
      const wallet = await walletsCollection.findOne({paymentId: walletBalance.account_id})
      const providerId = wallet.providerId
      client.query(createPotentialPaymentsQuery, [payoutReportId, walletBalance.account_id, providerId, walletBalance.balance])
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw (e)
  } finally {
    client.release()
  }
}

const initialize = async (debug, runtime) => {
  const interval = cron.parseExpression('0 0 1 * *', {})
  const next = interval.next().getTime()
  setTimeout(() => { monthly(debug, runtime) }, next - underscore.now())
}

export default {
  monthly,
  initialize
}
