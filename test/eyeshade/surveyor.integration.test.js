import {
  serial as test
} from 'ava'
import Postgres from 'bat-utils/lib/runtime-postgres'
import Queue from 'bat-utils/lib/runtime-queue'
import SDebug from 'sdebug'
import {
  workers
} from '../../eyeshade/workers/wallet'
import {
  freezeOldSurveyors
} from '../../eyeshade/workers/reports'
import {
  createSurveyor,
  getSurveyor,
  cleanPgDb
} from '../utils'
import {
  timeout
} from 'bat-utils/lib/extras-utils'

const {
  BAT_REDIS_URL,
  BAT_POSTGRES_URL
} = require('../../env')

const config = require('../../config').generate('eyeshade')

const votingReportWorker = workers['voting-report']

const debug = new SDebug('surveyor-test')

const postgres = new Postgres({ postgres: { url: BAT_POSTGRES_URL } })

const runtime = {
  config,
  postgres,
  queue: new Queue({ queue: BAT_REDIS_URL })
}

test.afterEach.always(cleanPgDb(postgres))

test('verify frozen occurs when daily is run', async t => {
  t.plan(12)
  let body

  await createSurveyor()
  // just made value
  ;({ body } = await getSurveyor())
  const { surveyorId } = body
  await waitUntilPropagated(querySurveyor, surveyorId)
  // does not freeze if midnight is before creation date
  // vote on surveyor, no rejectedVotes yet
  const publisher = 'fake-publisher'
  await voteAndCheckTally(t, publisher, surveyorId, 1)
  await voteAndCheckTally(t, publisher, surveyorId, 2)
  await tryFreeze(t, 0, false, surveyorId)
  // freezes if midnight is after creation date
  await voteAndCheckTally(t, publisher, surveyorId, 3)
  await tryFreeze(t, -1, true, surveyorId)
  // property is needed
  await voteAndCheckTally(t, publisher, surveyorId, 3)
})

async function tryFreeze (t, dayShift, expect, surveyorId) {
  await freezeOldSurveyors(debug, runtime, dayShift)
  // beware of cursor
  const surveyor = await querySurveyor(surveyorId)
  t.is(surveyor.rowCount, 1)
  t.is(surveyor.rows[0].frozen, expect)
}

function querySurveyor (surveyorId) {
  return postgres.query('select * from surveyor_groups where id = $1 limit 1;', [surveyorId])
}

function queryVotes (surveyorId) {
  return postgres.query('select * from votes where surveyor_id = $1 limit 1;', [surveyorId])
}

async function waitUntilPropagated (fn, surveyorId) {
  let finished = await fn(surveyorId)
  while (finished.rowCount !== 1) {
    await timeout(2000)
    finished = await fn(surveyorId)
  }
}

async function voteAndCheckTally (t, publisher, surveyorId, count) {
  await votingReportWorker(debug, runtime, {
    surveyorId,
    publisher
  })
  const votes = await queryVotes(surveyorId)
  t.is(votes.rowCount, 1)
  t.is(votes.rows[0].tally, count)
}
