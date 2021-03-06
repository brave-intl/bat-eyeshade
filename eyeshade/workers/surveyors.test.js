const { serial: test } = require('ava')
const BigNumber = require('bignumber.js')
const { Runtime } = require('bat-utils')
const moment = require('moment')
const uuid = require('uuid')
const SDebug = require('sdebug')
const format = require('pg-format')
const _ = require('underscore')
const { insertVote } = require('./acvote')
const { surveyorFrozenReport } = require('./surveyors')
const { cleanEyeshadePgDb } = require('../../test/utils')

test.before((t) => {
  Object.assign(t.context, {
    debug: new SDebug('test'),
    runtime: new Runtime({
      postgres: { url: process.env.BAT_POSTGRES_URL },
      testingCohorts: [],
      wallet: {
        settlementAddress: { BAT: uuid.v4() }
      }
    })
  })
})
test.beforeEach((t) => cleanEyeshadePgDb(t.context.runtime.postgres))

test('surveyor-frozen-report inserts votes correctly', async (t) => {
  // insert surveyors
  const { runtime, debug } = t.context
  const settlementAddress = runtime.config.wallet.settlementAddress.BAT
  const voteCount = 51
  const baseValue = '0.25'
  const ids = _.sortBy([...new Array(4)].map(() => uuid.v4()))
  const yesterday = moment().subtract(1, 'days')
  const date = yesterday.format('YYYY-MM-DD')
  await runtime.postgres.query(format('insert into surveyor_groups (id, price, frozen, virtual, created_at) values %L',
    ids.map((id) => ([
      `${date}_${id}`,
      baseValue,
      false,
      true,
      yesterday.toISOString()
    ]))
  ))
  await runtime.postgres.transact((client) =>
    Promise.all(ids.map((surveyorId) =>
      Promise.all([...new Array(voteCount)].map((_, index) =>
        insertVote(runtime, date, {
          fundingSource: surveyorId,
          voteTally: 1,
          baseVoteValue: baseValue,
          channel: channelFromIndex(index)
        }, client)
      ))
    ))
  )
  const {
    rows: beforeInsert
  } = await runtime.postgres.query(`select *
  from transactions
  order by document_id desc`)
  t.is(beforeInsert.length, 0)
  await Promise.all(ids.map((id) =>
    surveyorFrozenReport(debug, t.context.runtime, {
      surveyorId: `${date}_${id}`,
      mix: true
    })
  ))
  const {
    rows: surveyors
  } = await runtime.postgres.query(`select id, created_at
  from surveyor_groups`)
  const createdAtById = _.indexBy(surveyors, 'id')
  const {
    rows: afterInsert
  } = await runtime.postgres.query(`select *
  from transactions
  order by id`)
  t.is(afterInsert.length, ids.length * voteCount)

  const afterInsertById = _.indexBy(afterInsert, 'id')
  const recreated = _.sortBy(ids.reduce((memo, surveyorId) => {
    const fullSurveyorId = `${date}_${surveyorId}`
    return memo.concat([...new Array(voteCount)].map((_, index) => ({
      id: uuid.v5(fullSurveyorId + channelFromIndex(index), 'be90c1a8-20a3-4f32-be29-ed3329ca8630'),
      created_at: createdAtById[fullSurveyorId].created_at,
      description: `votes from ${fullSurveyorId}`,
      transaction_type: 'contribution',
      document_id: fullSurveyorId,
      from_account: settlementAddress,
      from_account_type: 'uphold',
      to_account: channelFromIndex(index),
      to_account_type: 'channel',
      amount: new BigNumber(baseValue).toFixed(18),
      channel: channelFromIndex(index),
      settlement_amount: null,
      settlement_currency: null
    })))
  }, []), 'id')
  recreated.forEach((row) => {
    row.inserted_at = afterInsertById[row.id].inserted_at
  })
  t.deepEqual(afterInsert, recreated)
})

function channelFromIndex (index) {
  return `${uuid.v5(index.toString(), 'dbe26373-c2f6-4c00-b3f3-fe4b423cf7bd').split('-')[0]}.com`
}
