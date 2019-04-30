import {
  serial as test
} from 'ava'
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
  cleanDbs,
  serverContext
} from '../utils'
import {
  timeout
} from 'bat-utils/lib/extras-utils'

const votingReportWorker = workers['voting-report']

const debug = new SDebug('surveyor-test')

test.before(serverContext)
test.afterEach.always(cleanDbs)

test('verify frozen occurs when daily is run', async t => {
  t.plan(12)
  let body
  const { ledger, eyeshade } = t.context

  await createSurveyor(ledger.agent)
  // just made value
  ;({ body } = await getSurveyor(ledger.agent))
  const { surveyorId } = body
  await waitUntilPropagated(querySurveyor, eyeshade.runtime, surveyorId)
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
  const { runtime } = t.context.eyeshade
  await freezeOldSurveyors(debug, runtime, dayShift)
  // beware of cursor
  const surveyor = await querySurveyor(runtime, surveyorId)
  t.is(surveyor.rowCount, 1)
  t.is(surveyor.rows[0].frozen, expect)
}

function querySurveyor (runtime, surveyorId) {
  return runtime.postgres.query('select * from surveyor_groups where id = $1 limit 1;', [surveyorId])
}

function queryVotes (runtime, surveyorId) {
  return runtime.postgres.query('select * from votes where surveyor_id = $1 limit 1;', [surveyorId])
}

async function waitUntilPropagated (fn, runtime, surveyorId) {
  let finished = await fn(runtime, surveyorId)
  while (finished.rowCount !== 1) {
    await timeout(2000)
    finished = await fn(runtime, surveyorId)
  }
}

async function voteAndCheckTally (t, publisher, surveyorId, count) {
  const { runtime } = t.context.eyeshade
  await votingReportWorker(debug, runtime, {
    surveyorId,
    publisher
  })
  const votes = await queryVotes(runtime, surveyorId)
  t.is(votes.rowCount, 1)
  t.is(votes.rows[0].tally, count)
}
