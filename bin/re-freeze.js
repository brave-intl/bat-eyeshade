#!/usr/bin/env node

const Queue = require('bat-utils/lib/runtime-queue')
const SDebug = require('sdebug')
const debug = new SDebug('migrate-transaction-table')

const Postgres = require('bat-utils/lib/runtime-postgres')

const {
  REDIS_URL,
  DATABASE_URL
} = require('../env')

async function main () {
  const queue = new Queue({ queue: REDIS_URL })
  const pg = new Postgres({ postgres: { url: DATABASE_URL } })

  const surveyorQ = await pg.query('select id from surveyor_groups where frozen;', [])
  if (surveyorQ.rowCount === 0) {
    throw new Error('surveyors do not exist')
  }

  for (let surveyor of surveyorQ.rows) {
    const surveyorId = surveyor.id
    if (surveyorId) {
      await queue.send(debug, 'surveyor-frozen-report', { surveyorId })
    }
  }

  await queue.rsmq.quit()
}

main().then(result => {}).catch(e => {
  console.error(e)
})
