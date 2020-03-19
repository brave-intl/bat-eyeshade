const { serial: test } = require('ava')
const {
  Runtime
} = require('bat-utils')
const _ = require('underscore')
const {
  timeout
} = require('bat-utils/lib/extras-utils')
const BigNumber = require('bignumber.js')
const {
  addSurveyorChoices
} = require('../../ledger/controllers/surveyor')
const {
  agents,
  getSurveyor,
  connectToDb,
  createSurveyor,
  cleanDbs,
  cleanPgDb,
  ok
} = require('../utils')

const runtime = new Runtime({
  postgres: {
    url: process.env.BAT_POSTGRES_URL
  },
  currency: {
    url: process.env.BAT_RATIOS_URL,
    access_token: process.env.BAT_RATIOS_TOKEN
  }
})

test.afterEach.always(cleanDbs)
test.afterEach.always(cleanPgDb(runtime.postgres))

test('verify voting batching endpoint does not error', async t => {
  t.plan(0)
  const surveyorType = 'voting'
  const url = `/v2/batch/surveyor/${surveyorType}`
  const data = [{ surveyorId: '...', proof: '...' }]

  await agents.ledger.global.post(url).send(data).expect(ok)

  const getURL = '/v2/batch/surveyor/16457ddb9913cd7928d3205ab455ecd'

  await agents.ledger.global.get(getURL).expect(ok)
})

test('verify surveyor sends back choices', async t => {
  let response

  const added = await addSurveyorChoices(runtime)
  response = await createSurveyor()
  checkResponse(response)
  response = await getSurveyor()
  const { choices } = added.payload.adFree
  console.log('choices', choices) // eslint-disable-line
  checkResponse(response, choices)
  t.plan(2 + choices.USD.length)
  for (let i = 0; i < choices.USD.length; i += 1) {
    t.true(_.isNumber(choices.USD[i]), 'each item is a number')
  }
  /*
  {
    USD: [20, 35, 50, 85]
  }
  */

  function checkResponse (response, expectation) {
    const { body } = response
    const { payload } = body
    const { adFree } = payload
    const { choices } = adFree
    t.deepEqual(choices, expectation)
  }
})

test('check votes ratio', async (t) => {
  const list = [{
    rate: '1',
    options: {}
  }, {
    rate: '0.25',
    options: {
      votes: 100,
      probi: (new BigNumber(25)).times(1e18).toString()
    }
  }]
  t.plan(list.length)

  for (let i = 0; i < list.length; i += 1) {
    const context = list[i]
    const {
      options,
      rate
    } = context
    const res = await createSurveyor(options)
    const encodedId = encodeURIComponent(res.body.surveyorId)
    const url = `/v1/surveyor/voterate/contribution/${encodedId}`
    const {
      body
    } = await agents.ledger.global
      .get(url)
      .expect(ok)

    t.deepEqual(body, {
      rate
    })
  }
})

test('required cohorts are added to surveyors', async (t) => {
  const { VOTING_COHORTS } = process.env
  const cohorts = VOTING_COHORTS ? VOTING_COHORTS.split(',') : []
  console.log('testing cohorts', cohorts)
  t.plan((cohorts.length * 2) + 1)
  t.true(cohorts.length >= 1, 'more than one cohort is expected')
  const {
    body: publicSurveyor
  } = await createSurveyor()
  const { surveyorId } = publicSurveyor

  const ledger = await connectToDb('ledger')
  const surveyors = ledger.collection('surveyors', () => {})
  const privateSurveyor = await findOneSurveyor()

  const encodedSurveyorId = encodeURIComponent(surveyorId)
  const {
    surveyorType
  } = privateSurveyor
  const url = `/v2/surveyor/${surveyorType}/${encodedSurveyorId}`

  await agents.ledger.global
    .get(url)
    .expect(ok)

  while (await noCohorts()) {
    await timeout(5000)
  }
  const privateFullSurveyor = await findOneSurveyor()
  cohorts.forEach((cohort) => {
    const surveyorCohortGrants = privateFullSurveyor.cohorts[cohort]
    t.true(_.isArray(surveyorCohortGrants), `an array is present for ${cohort}`)
    t.true(surveyorCohortGrants.length > 0, 'the array is not empty')
  })

  await surveyors.remove({
    surveyorId
  })
  await runtime.postgres.query('DELETE FROM surveyor_groups WHERE id = $1::text;', [surveyorId])

  function findOneSurveyor () {
    return surveyors.findOne({
      surveyorId
    })
  }

  async function noCohorts () {
    const privateFullSurveyor = await findOneSurveyor()
    return !privateFullSurveyor.cohorts
  }
})
