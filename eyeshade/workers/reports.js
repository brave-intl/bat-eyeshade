const {
  timeout
} = require('bat-utils/lib/extras-utils')
const { surveyorFrozenReport } = require('./surveyors')
const SDebug = require('sdebug')
const defaultDebug = new SDebug('worker')
const options = { id: 1 }
defaultDebug.initialize({ web: { id: options.id } })

exports.debug = defaultDebug

const freezeInterval = process.env.FREEZE_SURVEYORS_AGE_DAYS

async function runFreezeOldSurveyors (debug, runtime) {
  try {
    await freezeOldSurveyors(debug, runtime)
  } catch (ex) {
    runtime.captureException(ex)
    debug('daily', { reason: ex.toString(), stack: ex.stack })
  }
}

exports.runFreezeOldSurveyors = runFreezeOldSurveyors

exports.name = 'reports'
exports.freezeOldSurveyors = freezeOldSurveyors

/*
  olderThanDays: int
*/
async function freezeOldSurveyors (debug, runtime, olderThanDays) {
  if (typeof olderThanDays === 'undefined') {
    olderThanDays = freezeInterval
  }

  const query = `
  select id from surveyor_groups
  where not frozen
  and not virtual
  and created_at < current_date - $1 * interval '1d'
  `

  const {
    rows: nonVirtualSurveyors
  } = await runtime.postgres.query(query, [olderThanDays], true)

  const virtualQuery = `
  select id from surveyor_groups
  where not frozen
  and virtual
  and created_at < current_date
  `

  const {
    rows: virtualSurveyors
  } = await runtime.postgres.query(virtualQuery, [], true)

  const toFreeze = nonVirtualSurveyors.concat(virtualSurveyors)
  for (let i = 0; i < toFreeze.length; i += 1) {
    const surveyorId = toFreeze[i].id
    await surveyorFrozenReport(debug, runtime, { surveyorId, mix: true })
    await waitForTransacted(runtime, surveyorId)
  }
}

async function waitForTransacted (runtime, surveyorId) {
  let row
  const start = new Date()
  do {
    if (+(new Date()) >= 5) {
      await timeout(5 * 1000)
    }
    const statement = `
    select *
    from votes
    where
        surveyor_id = $1
    and not transacted
    limit 1`
    const { rows } = await runtime.postgres.query(statement, [surveyorId], true)
    row = rows[0]
    if (new Date() - (1000 * 60 * 60) > start) {
      runtime.captureException(new Error('unable to finish freezing process'), {
        extra: {
          surveyorId
        }
      })
      return
    }
  } while (row) // when no row is returned, all votes have been transacted
}
