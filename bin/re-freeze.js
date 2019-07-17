#!/usr/bin/env node

const Queue = require('bat-utils/lib/runtime-queue')
const SDebug = require('sdebug')
const debug = new SDebug('migrate-transaction-table')

const Postgres = require('bat-utils/lib/runtime-postgres')

async function main () {
  const queue = new Queue({ queue: process.env.REDIS_URL })
  const pg = new Postgres({ postgres: { url: process.env.DATABASE_URL } })

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

  await queue.quit()
}

main().then(result => {}).catch(e => {
  console.error(e)
})
