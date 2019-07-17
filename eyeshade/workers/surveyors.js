const { insertFromVoting, updateBalances } = require('../lib/transaction.js')
const { mixer } = require('../workers/reports.js')

exports.name = 'surveyors'
exports.initialize = async (debug, runtime) => {
  await runtime.queue.create('surveyor-frozen-report')
}

exports.workers = {
/* sent by freezeOldSurveyors

    { queue            : 'surveyor-frozen-report'
    , message          :
      { surveyorId  : '...'
      , mix         : false
      , shouldUpdateBalances: false
      }
    }
*/
  'surveyor-frozen-report':
    async (debug, runtime, payload) => {
      // FIXME should rework this
      const { postgres } = runtime
      const { mix, surveyorId, shouldUpdateBalances } = payload

      const surveyorQ = await postgres.query('select created_at from surveyor_groups where id = $1 limit 1;', [surveyorId])
      if (surveyorQ.rowCount !== 1) {
        throw new Error('surveyor does not exist')
      }
      const surveyorCreatedAt = surveyorQ.rows[0].created_at

      if (mix) {
        await mixer(debug, runtime, undefined, undefined)
      }

      const client = await runtime.postgres.connect()
      try {
        const query1 = `
        select
          votes.channel,
          coalesce(sum(votes.amount), 0.0) as amount,
          coalesce(sum(votes.fees), 0.0) as fees
        from votes where surveyor_id = $1 and not excluded and not transacted and amount is not null
        group by votes.channel;
        `
        const votingQ = await client.query(query1, [surveyorId])
        if (!votingQ.rowCount) {
          throw new Error('no votes for this surveyor!')
        }
        const docs = votingQ.rows

        await client.query('BEGIN')
        try {
          for (let doc of docs) {
            await insertFromVoting(runtime, client, Object.assign(doc, { surveyorId }), surveyorCreatedAt)
          }
        } catch (e) {
          await client.query('ROLLBACK')
          runtime.captureException(e, { extra: { report: 'surveyor-frozen-report', surveyorId } })
          throw e
        }

        const query2 = `
        update votes
          set transacted = true
        from
        (select votes.id
          from votes join transactions
          on (transactions.document_id = votes.surveyor_id and transactions.to_account = votes.channel)
          where not votes.excluded and votes.surveyor_id = $1
        ) o
        where votes.id = o.id
        `
        await client.query(query2, [surveyorId])

        await client.query('COMMIT')

        if (shouldUpdateBalances) {
          await updateBalances(runtime, client, true)
        }
      } finally {
        client.release()
      }
    }
}
