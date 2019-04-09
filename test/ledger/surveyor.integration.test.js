import { serial as test } from 'ava'
import {
  Runtime
} from 'bat-utils'
import _ from 'underscore'
import {
  timeout
} from 'bat-utils/lib/extras-utils'
import BigNumber from 'bignumber.js'
import {
  addSurveyorChoices
} from '../../ledger/controllers/surveyor'
import {
  getSurveyor,
  connectToDb,
  createSurveyor,
  ledgerAgent,
  cleanDbs,
  cleanPgDb,
  ok
} from '../utils'

const {
  VOTING_COHORTS,
  BAT_POSTGRES_URL,
  BAT_RATIOS_URL,
  BAT_RATIOS_TOKEN
} = require('../../env')

const runtime = new Runtime({
  postgres: {
    url: BAT_POSTGRES_URL
  },
  currency: {
    url: BAT_RATIOS_URL,
    access_token: BAT_RATIOS_TOKEN
  }
})

test.afterEach.always(cleanDbs)
test.afterEach.always(cleanPgDb(runtime.postgres))

test('verify voting batching endpoint does not error', async t => {
  t.plan(0)
  const surveyorType = 'voting'
  const url = `/v2/batch/surveyor/${surveyorType}`
  const data = [ { surveyorId: '...', proof: '...' } ]

  await ledgerAgent.post(url).send(data).expect(ok)

  const getURL = `/v2/batch/surveyor/16457ddb9913cd7928d3205ab455ecd`

  await ledgerAgent.get(getURL).expect(ok)
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
  for (let number of choices.USD) {
    t.true(_.isNumber(number), 'each item is a number')
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

  for (let context of list) {
    const {
      options,
      rate
    } = context
    const res = await createSurveyor(options)
    const encodedId = encodeURIComponent(res.body.surveyorId)
    const url = `/v1/surveyor/voterate/contribution/${encodedId}`
    const {
      body
    } = await ledgerAgent
      .get(url)
      .expect(ok)

    t.deepEqual(body, {
      rate
    })
  }
})

test('required cohorts are added to surveyors', async (t) => {
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

  await ledgerAgent
    .get(url)
    .expect(ok)

  while (await noCohorts()) {
    await timeout(5000)
  }
  const privateFullSurveyor = await findOneSurveyor()
  cohorts.forEach((cohort) => {
    const surveyorCohortGrants = privateFullSurveyor.cohorts[cohort]
    t.true(_.isArray(surveyorCohortGrants), 'an array is present')
    t.true(surveyorCohortGrants.length > 0, 'the array is not empty')
  })

  await surveyors.remove({
    surveyorId
  })
  await runtime.postgres.query(`DELETE FROM surveyor_groups WHERE id = $1::text;`, [surveyorId])

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
