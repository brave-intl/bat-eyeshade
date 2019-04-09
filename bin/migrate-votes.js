#!/usr/bin/env node

const BigNumber = require('bignumber.js')
const Database = require('bat-utils/lib/runtime-database')
const SDebug = require('sdebug')
const debug = new SDebug('migrate-transaction-table')
const uuidv5 = require('uuid/v5')

const Postgres = require('bat-utils/lib/runtime-postgres')

const {
  createdTimestamp,
  normalizeChannel
} = require('bat-utils/lib/extras-utils')

const {
  MONGODB_URI,
  DATABASE_URL
} = require('../env')

async function consume (pg, votings) {
  return Promise.all(votings.map(async (voting) => {
    const { publisher, cohort } = voting
    if (publisher && cohort) {
      const normalizedChannel = normalizeChannel(voting.publisher)
      const created = createdTimestamp(voting._id)

      const probi = voting.probi && new BigNumber(voting.probi.toString())
      const fees = voting.probi && new BigNumber(voting.fees.toString())

      await pg.pool.query('insert into votes (id, created_at, updated_at, cohort, amount, fees, tally, excluded, transacted, channel, surveyor_id) values ($1, to_timestamp($2), to_timestamp($3), $4, $5, $6, $7, $8, $9, $10, $11)', [
            // channel, cohort and surveyor group id should be unique per
        uuidv5(normalizedChannel + voting.cohort + voting.surveyorId, 'f0ca8ff9-8399-493a-b2c2-6d4a49e5223a'),
        created / 1000,
        voting.timestamp.high_,
        voting.cohort,
        (probi && probi.dividedBy('1e18').toString()) || null,
        (fees && fees.dividedBy('1e18').toString()) || null,
        voting.counts,
        voting.exclude,
        false,
        normalizedChannel,
        voting.surveyorId
      ])
    } else {
      throw new Error('nani')
    }
  }))
}

async function main () {
  const database = new Database({ database: MONGODB_URI })
  const pg = new Postgres({ postgres: { url: DATABASE_URL } })

  const votingC = database.get('voting', debug)
  const surveyorC = database.get('surveyors', debug)
  const surveyors = await surveyorC.find()

  for (let surveyor of surveyors) {
    const { surveyorId } = surveyor
    const created = createdTimestamp(surveyor._id)

    const probi = surveyor.probi && new BigNumber(surveyor.probi.toString())
    const price = probi.dividedBy('1e18').dividedBy(surveyor.votes)

    await pg.pool.query('insert into surveyor_groups (id, created_at, updated_at, price, ballots, frozen) values ($1, to_timestamp($2), to_timestamp($3), $4, $5, $6)', [
      surveyorId,
      created / 1000,
      surveyor.timestamp.high_,
      price.toString(),
      surveyor.counts,
      surveyor.frozen || false
    ])

    console.log('fetching surveyor: ' + surveyorId)
    const votings = await votingC.find({surveyorId})
    await consume(pg, votings)
  }

  const surveyorIds = surveyors.map((surveyor) => surveyor.surveyorId)
  const votings = await votingC.find({ 'surveyorId': { '$nin': surveyorIds } })
  await consume(pg, votings)

  const backfillTransacted = `
update votes
  set transacted = true
from
(select votes.id
  from votes join transactions
  on (transactions.document_id = votes.surveyor_id and transactions.to_account = votes.channel)
  where not votes.excluded
) o
where votes.id = o.id
;
 `

  await pg.pool.query(backfillTransacted, [])

  await database.db.close()
}

main().then(result => {}).catch(e => {
  console.error(e)
})
