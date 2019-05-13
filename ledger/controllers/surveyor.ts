import Joi from 'joi'
import anonize from 'node-anonize2-relic'
import boom from 'boom'
import bson from 'bson'
import underscore from 'underscore'
import surveyorsLib from '../lib/surveyor'
import utils from 'bat-utils'

const braveHapi = utils.extras.hapi
const braveJoi = utils.extras.joi
const { surveyorChoices } = utils.extras.utils

const slop = 35

const server = async (request, reply, runtime) => {
  const debug = braveHapi.debug(module, request)
  const surveyorType = request.params.surveyorType
  const surveyorId = request.params.surveyorId
  const surveyors = runtime.database.get('surveyors', debug)
  let entry, surveyor

  if ((surveyorId === 'current') && (surveyorType === 'contribution')) {
    entry = await surveyors.findOne({ surveyorType: surveyorType, active: true })
  } else {
    entry = await surveyors.findOne({ surveyorId: surveyorId })
  }
  if (!entry) reply(boom.notFound('surveyor does not exist: ' + surveyorId))
  else if (entry.surveyorType !== surveyorType) reply(boom.badData('surveyorType mismatch for: ' + surveyorId))
  else {
    surveyor = new anonize.Surveyor(entry.parameters)
    surveyor.surveyorId = entry.surveyorId
    surveyor.surveyorType = entry.surveyorType
    surveyor.payload = entry.payload
    surveyor.parentId = entry.parentId
  }
  return surveyor && addSurveyorChoices(runtime, surveyor)
}

const registrarType = (surveyorType) => {
  return { contribution: 'persona', voting: 'viewing' }[surveyorType]
}

const validateV2 = (surveyorType, payload) => {
  const fee = Joi.object().keys({ USD: Joi.number().min(1).required() }).unknown(true).required()
  const altcurrency = braveJoi.string().altcurrencyCode().optional()
  const probi = braveJoi.string().numeric().optional()
  const votes = Joi.number().integer().min(1).max(100).required()
  const schema = {
    contribution: Joi.object().keys({ adFree: Joi.object().keys({ votes: votes, altcurrency: altcurrency, probi: probi, fee: fee }) }).required()
  }[surveyorType] || Joi.object().max(0)

  return Joi.validate(payload || {}, schema)
}

const enumerate = async (runtime, surveyorType, payload) => {
  payload.adFree.altcurrency = payload.adFree.altcurrency || 'BTC'
  let params = (payload || {}).adFree

  if ((surveyorType !== 'contribution') || underscore.isUndefined(params)) {
    return payload
  }
  let {
    probi,
    altcurrency,
    fee
  } = params

  if (!probi) {
    const feeKeys = underscore.keys(fee)
    for (var i = 0; i < feeKeys.length; i += 1) {
      const currency = feeKeys[i]
      const amount = fee[currency]
      if (amount) {
        probi = await runtime.currency.fiat2alt(currency, amount, altcurrency).toString()
        if (probi) {
          params.probi = probi
          break
        }
      }
    }
  }
  if (!probi) return

  return payload
}

/*
   GET /v2/surveyor/{surveyorType}/{surveyorId}
 */

const v2Read =
{ handler: (runtime) => {
  return async (request, reply) => {
    const debug = braveHapi.debug(module, request)
    const surveyorType = request.params.surveyorType
    let surveyor

    surveyor = await server(request, reply, runtime)
    if (!surveyor) return

    reply(underscore.extend({ payload: surveyor.payload }, surveyor.publicInfo()))

    if (surveyorType === 'contribution') provision(debug, runtime, surveyor.surveyorId, 0)
  }
},

  description: 'Returns information about a surveyor',
  tags: [ 'api' ],

  validate: {
    params: {
      surveyorType: Joi.string().valid('contribution', 'voting').required().description('the type of the surveyor'),
      surveyorId: Joi.string().required().description('the identity of the surveyor'),
      apiV: Joi.string().required().description('the api version')
    }
  },

  response: {
    schema: Joi.object().keys({
      surveyorId: Joi.string().required().description('identifier for the surveyor'),
      surveyVK: Joi.string().required().description('public key for the surveyor'),
      registrarVK: Joi.string().required().description('public key for the associated registrar'),
      payload: Joi.object().required().description('additional information')
    })
  }
}

/*
   POST /v2/surveyor/{surveyorType}
 */

const v2Create =
{ handler: (runtime) => {
  return async (request, reply) => {
    const debug = braveHapi.debug(module, request)
    const surveyorType = request.params.surveyorType
    let surveyor
    let payload = request.payload || {}

    const validity = validateV2(surveyorType, payload)

    if (validity.error) return reply(boom.badData(validity.error))

    payload = await enumerate(runtime, surveyorType, payload)
    if (!payload) return reply(boom.badData('no available currencies'))

    surveyor = await create(debug, runtime, surveyorType, payload, null)
    if (!surveyor) return reply(boom.notFound('invalid surveyorType: ' + surveyorType))

    reply(underscore.extend({ payload: payload }, surveyor.publicInfo()))
  }
},

  auth: {
    strategy: 'session',
    scope: [ 'ledger' ],
    mode: 'required'
  },

  description: 'Creates a new surveyor',
  tags: [ 'api' ],

  validate: {
    params: {
      surveyorType: Joi.string().valid('contribution', 'voting').required().description('the type of the surveyor'),
      apiV: Joi.string().required().description('the api version')
    },
    payload: Joi.object().optional().description('additional information')
  },

  response: {
    schema: Joi.object().keys({
      surveyorId: Joi.string().required().description('identifier for the surveyor'),
      surveyVK: Joi.string().required().description('public key for the surveyor'),
      registrarVK: Joi.string().required().description('public key for the associated registrar'),
      payload: Joi.object().optional().description('additional information')
    })
  }
}

/*
   PATCH /v2/surveyor/{surveyorType}/{surveyorId}
 */

const v2Update =
{ handler: (runtime) => {
  return async (request, reply) => {
    const bump = request.query.bump
    const surveyorType = request.params.surveyorType
    const debug = braveHapi.debug(module, request)
    const surveyors = runtime.database.get('surveyors', debug)
    let state, surveyor, validity
    let payload = request.payload

    surveyor = await server(request, reply, runtime)
    if (!surveyor) return

    validity = validateV2(surveyorType, payload)

    if (validity.error) return reply(boom.badData(validity.error))

    payload = await enumerate(runtime, surveyorType, payload)
    if (!payload) return reply(boom.badData('no available currencies'))

    state = { $currentDate: { timestamp: { $type: 'timestamp' } }, $set: { payload: payload } }
    await surveyors.update({ surveyorId: surveyor.surveyorId }, state, { upsert: false })

    if (surveyorType === 'contribution') {
      await runtime.queue.send(debug, 'surveyor-report',
                               underscore.extend({ surveyorId: surveyor.surveyorId, surveyorType: surveyorType },
                                                 underscore.pick(payload.adFree, [ 'altcurrency', 'probi', 'votes' ])))
    }

    surveyor.payload = payload
    reply(underscore.extend({ payload: payload }, surveyor.publicInfo()))

    if (surveyorType === 'contribution') provision(debug, runtime, surveyor.surveyorId, bump)
  }
},

  auth: {
    strategy: 'session',
    scope: [ 'ledger' ],
    mode: 'required'
  },

  description: 'Updates a surveyor',
  tags: [ 'api' ],

  validate: {
    query: {
      bump: Joi.number().integer().min(1).max(100).optional().description('number of additional requested surveyors')
    },
    params: {
      surveyorType: Joi.string().valid('contribution', 'voting').required().description('the type of the surveyor'),
      surveyorId: Joi.string().required().description('the identity of the surveyor'),
      apiV: Joi.string().required().description('the api version')
    },
    payload: Joi.object().optional().description('additional information')
  },

  response: {
    schema: Joi.object().keys({
      surveyorId: Joi.string().required().description('identifier for the surveyor'),
      surveyVK: Joi.string().required().description('public key for the surveyor'),
      registrarVK: Joi.string().required().description('public key for the associated registrar'),
      payload: Joi.object().optional().description('additional information')
    })
  }
}

/*
   GET /v2/surveyor/{surveyorType}/{surveyorId}/{uId}
 */

const v2Phase1 =
{ handler: (runtime) => {
  return async (request, reply) => {
    const debug = braveHapi.debug(module, request)
    const surveyorId = request.params.surveyorId
    const surveyorType = request.params.surveyorType
    const uId = request.params.uId.toLowerCase()
    const credentials = runtime.database.get('credentials', debug)
    let entry, f, registrar, signature, surveyor

    surveyor = await server(request, reply, runtime)
    if (!surveyor) return

    registrar = runtime.registrars[registrarType(surveyorType)]
    if (!registrar) return reply(boom.badImplementation('unable to find registrar for ' + surveyorType))

    entry = await credentials.findOne({ uId: uId, registrarId: registrar.registrarId })

    f = {
      contribution:
            async () => {
              if (!entry) return reply(boom.notFound('personaId not valid: ' + uId))
            },

      voting:
            async () => {
              const viewings = runtime.database.get('viewings', debug)
              let viewing

              if (!entry) return reply(boom.notFound('viewingId not valid(1): ' + uId))

              viewing = await viewings.findOne({ uId: uId })
              if (!viewing) return reply(boom.notFound('viewingId not valid(2): ' + uId))

              if (viewing.surveyorIds.indexOf(surveyorId) === -1) return reply(boom.notFound('viewingId not valid(3): ' + uId))
            }
    }[surveyor.surveyorType]
    if ((!!f) && (await f())) return

    const now = underscore.now()
    signature = surveyor.sign(uId)
    runtime.newrelic.recordCustomEvent('sign', {
      surveyorId: surveyor.surveyorId,
      surveyorType: surveyor.surveyorType,
      duration: underscore.now() - now
    })

    const payload = surveyor.payload

    reply(underscore.extend({ signature: signature, payload: payload }, surveyor.publicInfo()))
  }
},

  description: 'Generates an initialization response for a surveyor',
  tags: [ 'api' ],

  validate: {
    params: {
      surveyorType: Joi.string().valid('contribution', 'voting').required().description('the type of the surveyor'),
      surveyorId: Joi.string().required().description('the identity of the surveyor'),
      uId: Joi.string().hex().length(31).required().description('the universally-unique identifier'),
      apiV: Joi.string().required().description('the api version')
    }
  },

  response: {
    schema: Joi.object().keys({
      surveyorId: Joi.string().required().description('identifier for the surveyor'),
      surveyVK: Joi.string().required().description('public key for the surveyor'),
      registrarVK: Joi.string().required().description('public key for the associated registrar'),
      signature: Joi.string().required().description('initialization response for the surveyor'),
      payload: Joi.object().optional().description('additional information')
    })
  }
}

/*
   PUT /v2/surveyor/{surveyorType}/{surveyorId}
 */

const v2Phase2 =
{ handler: (runtime) => {
  return async (request, reply) => {
    const debug = braveHapi.debug(module, request)
    const proof = request.payload.proof
    const submissions = runtime.database.get('submissions', debug)
    let data, entry, f, response, result, state, submissionId, surveyor

    surveyor = await server(request, reply, runtime)
    if (!surveyor) return

    try {
      const now = underscore.now()
      result = surveyor.verify(proof)
      runtime.newrelic.recordCustomEvent('verify', {
        surveyorId: surveyor.surveyorId,
        surveyorType: surveyor.surveyorType,
        duration: underscore.now() - now
      })
      data = JSON.parse(result.data)
    } catch (ex) {
      return reply(boom.badData('invalid surveyor proof: ' + JSON.stringify(proof)))
    }
    submissionId = result.token

    entry = await submissions.findOne({ submissionId: submissionId })
    if (entry) {
// NB: in case of a network error on the response (or a premature Heroku 503, etc.)
      return reply(entry.response)
    }

    response = { submissionId: submissionId }
    f = {
      contribution:
            async () => {
              const schema = Joi.object().keys({ viewingId: Joi.string().guid().required() })
              const validity = Joi.validate(data.report, schema)

              if (validity.error) return reply(boom.badData(validity.error))
            },

      voting:
            async () => {
              const schema = Joi.object().keys({ publisher: braveJoi.string().publisher().required() })
              const validity = Joi.validate(data, schema)

              if (validity.error) return reply(boom.badData(validity.error))

              await runtime.queue.send(debug, 'voting-report', underscore.extend({ surveyorId: surveyor.parentId, cohort: surveyor.payload.cohort || 'control' }, data))
            }
    }[surveyor.surveyorType]
    if ((!!f) && (await f())) return

    state = { $currentDate: { timestamp: { $type: 'timestamp' } }, $set: { response: response } }
    await submissions.update({ submissionId: submissionId }, state, { upsert: true })

    reply(response)
  }
},

  description: 'Submits a completed report',
  tags: [ 'api' ],

  validate: {
    params: {
      surveyorType: Joi.string().valid('contribution', 'voting').required().description('the type of the surveyor'),
      surveyorId: Joi.string().required().description('the identity of the surveyor'),
      apiV: Joi.string().required().description('the api version')
    },

    payload: { proof: Joi.string().required().description('report information and proof') }
  },

  response:
    { schema: Joi.object().keys({ submissionId: Joi.string().required().description('verification submissionId') }) }
}

/*
   GET /v1/surveyor/voterate/{surveyorType}/{surveyorId}
*/

const v1GetVoteRate = {
  handler: getVoteRate(),
  auth: {
    strategy: 'simple',
    mode: 'required'
  },

  description: 'Retrieves vote rate about surveyor',
  tags: [ 'api' ],

  validate: {
    params: {
      surveyorType: Joi.string().required().description('the type of surveyor'),
      surveyorId: Joi.string().required().description('the surveyor id to check')
    }
  },

  response: {
    schema: {
      rate: braveJoi.string().numeric().required().description('vote / bat available in surveyor')
    }
  }
}

const create = async (debug, runtime, surveyorType, payload, parentId) => {
  const surveyors = runtime.database.get('surveyors', debug)
  let registrar, state, surveyor

  registrar = runtime.registrars[registrarType(surveyorType)]
  if (!registrar) return

  surveyor = new anonize.Surveyor().initialize(registrar.publicInfo().registrarVK)
  surveyor.surveyorId = surveyor.parameters.surveyorId
  surveyor.surveyorType = surveyorType
  surveyor.payload = payload

  state = {
    $currentDate: { timestamp: { $type: 'timestamp' } },
    $set: underscore.extend({
      surveyorType: surveyorType,
      active: surveyorType !== 'contribution',
      available: true,
      payload: payload
    }, surveyor)
  }
  if (parentId) state.$set.parentId = parentId
  await surveyors.update({ surveyorId: surveyor.surveyorId }, state, { upsert: true })

  if (surveyorType !== 'contribution') return surveyor

  provision(debug, runtime, surveyor.surveyorId, 0)

  state = { $set: { active: false } }
  await surveyors.update({ surveyorType: 'contribution', active: true }, state, { upsert: false, multi: true })

  state = { $set: { active: true } }
  await surveyors.update({ surveyorId: surveyor.surveyorId }, state, { upsert: false })

  await runtime.queue.send(debug, 'surveyor-report',
                           underscore.extend({ surveyorId: surveyor.surveyorId, surveyorType: surveyorType },
                                             underscore.pick(payload.adFree, [ 'altcurrency', 'probi', 'votes' ])))

  return surveyor
}

const provision = async (debug, runtime, surveyorId, bump) => {
  const surveyors = runtime.database.get('surveyors', debug)
  let contributionSurveyors

  if (surveyorId) {
    contributionSurveyors = []
    const matchingSurveyor = await surveyors.findOne({ surveyorId: surveyorId })
    if (matchingSurveyor) contributionSurveyors.push(matchingSurveyor)
  } else {
    contributionSurveyors = await surveyors.find({ surveyorType: 'contribution', available: true }, { limit: 1000, sort: { timestamp: -1 } })
  }
  if (!bump) bump = 0
  if (!contributionSurveyors) {
    return
  }

  const { VOTING_COHORTS } = process.env
  const cohorts = VOTING_COHORTS ? VOTING_COHORTS.split(',') : surveyorsLib.cohorts
  await Promise.all(contributionSurveyors.map(async (cSurveyor) => {
    let count, vSurveyor

    if (!cSurveyor.cohorts) cSurveyor.cohorts = {}

    const desiredCount = ((cSurveyor.payload.adFree.votes * 4) + bump + slop)

    for (let cohort of cohorts) {
      if (!cSurveyor.cohorts[cohort]) cSurveyor.cohorts[cohort] = []

      count = desiredCount - cSurveyor.cohorts[cohort].length
      while (count > 0) {
        vSurveyor = await create(debug, runtime, 'voting', { cohort: cohort }, cSurveyor.surveyorId)
        if (!vSurveyor) {
          debug('surveyor', 'unable to create ' + count + ' voting surveyors')
          return
        }

        cSurveyor.cohorts[cohort].push(vSurveyor.surveyorId)

        count--
      }
    }

    await surveyors.update({ surveyorId: cSurveyor.surveyorId }, { $set: { cohorts: cSurveyor.cohorts } }, { upsert: true })
  }))
}

/*
   POST /{apiV}/batch/surveyor/voting
 */

const v2BatchVote =
{ handler: (runtime) => {
  return async (request, reply) => {
    const f = v2.phase2.handler(runtime)
    const id = request.id
    const params = request.params
    const payload = request.payload
    const results = []

    for (let item of payload) {
      // only these three properties are needed...
      await f({
        id: id,
        params: underscore.extend({ surveyorType: 'voting', surveyorId: item.surveyorId }, params),
        payload: { proof: item.proof }
      }, (response) => {
        results.push({
          surveyorId: item.surveyorId,
          response: (response.isBoom && response.output && response.output.payload) || response
        })
      })
    }

    return reply(results)
  }
},

  description: 'Submits a completed report',
  tags: [ 'api' ],

  validate: {
    params: { apiV: Joi.string().valid('v2').required().description('the api version') },

    payload: Joi.array().min(1).items(
      Joi.object().keys({
        surveyorId: Joi.string().required().description('the identity of the surveyor'),
        proof: Joi.string().required().description('report information and proof')
      })
    )
  },

  response: {
    schema: Joi.array().min(1).items(
      Joi.object().keys({
        surveyorId: Joi.string().required().description('the identity of the surveyor'),

        response: Joi.alternatives().try(
          Joi.object().keys({
            submissionId: Joi.string().required().description('verification submissionId')
          }),

          Joi.object().keys({
            statusCode: Joi.number().min(400).max(599).required(),
            error: Joi.string().optional(),
            message: Joi.string().optional()
          }).description('boom result')
        )
      })
    )
  }
}

/*
   GET /{apiV}/batch/surveyor/voting/{uId}
 */

const v2BatchSurveyor =
{ handler: (runtime) => {
  return async (request, reply) => {
    const debug = braveHapi.debug(module, request)
    const surveyorType = 'voting'
    const uId = request.params.uId.toLowerCase()
    const credentials = runtime.database.get('credentials', debug)
    let entry, registrar, signature

    registrar = runtime.registrars[registrarType(surveyorType)]
    if (!registrar) return reply(boom.badImplementation('unable to find registrar for ' + surveyorType))

    entry = await credentials.findOne({ uId: uId, registrarId: registrar.registrarId })

    if (!entry) return reply(boom.notFound('viewingId not valid(1): ' + uId))

    const viewings = runtime.database.get('viewings', debug)
    const viewing = await viewings.findOne({ uId: uId })

    if (!viewing) return reply(boom.notFound('viewingId not valid(2): ' + uId))

    const surveyors = await Promise.all(viewing.surveyorIds.map(async (surveyorId) => {
      const request = {
        params: {
          surveyorId,
          surveyorType
        }
      }
      return server(request, reply, runtime)
    }))

    const now = underscore.now()

    const payload = surveyors.map((surveyor: any) => {
      signature = surveyor.sign(uId)
      runtime.newrelic.recordCustomEvent('sign', {
        surveyorId: surveyor.surveyorId,
        surveyorType: surveyor.surveyorType,
        duration: underscore.now() - now
      })
      return underscore.extend({ signature, payload: surveyor.payload }, surveyor.publicInfo())
    })

    reply(payload)
  }
},

  description: 'Batch for initialization response for a surveyors',
  tags: [ 'api' ],

  validate: {
    params: {
      apiV: Joi.string().required().description('the api version'),
      uId: Joi.string().hex().length(31).required().description('the universally-unique identifier')
    }
  },

  response: {
    schema: Joi.alternatives().try(
      Joi.array().items(
        Joi.object().keys({
          surveyorId: Joi.string().required().description('identifier for the surveyor'),
          surveyVK: Joi.string().required().description('public key for the surveyor'),
          registrarVK: Joi.string().required().description('public key for the associated registrar'),
          signature: Joi.string().required().description('initialization response for the surveyor'),
          payload: Joi.object().optional().description('additional information')
        })
      ),
      Joi.object().keys({
        statusCode: Joi.number().min(400).max(599).required(),
        error: Joi.string().optional(),
        message: Joi.string().optional()
      }).description('boom result')
    )
  }
}

const v1 = {
  getVoteRate: v1GetVoteRate
}

const v2 = {
  read: v2Read,
  create: v2Create,
  update: v2Update,
  phase1: v2Phase1,
  phase2: v2Phase2,
  batchVote: v2BatchVote,
  batchSurveyor: v2BatchSurveyor
}

const routes = [
  braveHapi.routes.async().path('/v1/surveyor/voterate/{surveyorType}/{surveyorId}').config(v1.getVoteRate),
  braveHapi.routes.async().path('/{apiV}/surveyor/{surveyorType}/{surveyorId}').config(v2.read),
  braveHapi.routes.async().post().path('/{apiV}/surveyor/{surveyorType}').config(v2.create),
  braveHapi.routes.async().patch().path('/{apiV}/surveyor/{surveyorType}/{surveyorId}').config(v2.update),
  braveHapi.routes.async().path('/{apiV}/surveyor/{surveyorType}/{surveyorId}/{uId}').config(v2.phase1),
  braveHapi.routes.async().put().path('/{apiV}/surveyor/{surveyorType}/{surveyorId}').config(v2.phase2),
  braveHapi.routes.async().post().path('/{apiV}/batch/surveyor/voting').config(v2.batchVote),
  braveHapi.routes.async().path('/{apiV}/batch/surveyor/voting/{uId}').config(v2.batchSurveyor)
]

const initialize = async (debug, runtime) => {
  const configurations = process.env.SURVEYORS || 'contribution,voting'
  const surveyors = runtime.database.get('surveyors', debug)
  let entry, i, service, services, surveyor, surveyorType

  await runtime.database.checkIndices(debug, [
    {
      category: surveyors,
      name: 'surveyors',
      property: 'surveyorId',
      empty: { surveyorId: '', surveyorType: '', active: false, available: false, payload: {}, timestamp: bson.Timestamp.ZERO },
      unique: [ { surveyorId: 1 } ],
      others: [ { surveyorType: 1 }, { active: 1 }, { available: 1 }, { timestamp: 1 } ]
    },
    {
      category: runtime.database.get('submissions', debug),
      name: 'submissions',
      property: 'submissionId',
      empty: { submissionId: '', surveyorId: '', timestamp: bson.Timestamp.ZERO },
      unique: [ { submissionId: 1 } ],
      others: [ { surveyorId: 1 }, { timestamp: 1 } ]
    }
  ])

  await runtime.queue.create('surveyor-report')
  await runtime.queue.create('voting-report')

  services = configurations.split(',')
  for (i = services.length - 1; i >= 0; i--) {
    service = services[i].split(':')
    surveyorType = service[0]

    entry = await surveyors.findOne({ surveyorType: surveyorType, active: true })
    if (entry) {
      surveyor = new anonize.Surveyor(entry.parameters)
      surveyor.surveyorId = entry.surveyorId
      surveyor.surveyorType = surveyorType
      surveyor.payload = entry.payload

      if ((surveyorType === 'contribution') ||
            ((typeof process.env.DYNO !== 'undefined') && (process.env.DYNO !== 'web.1'))) continue

      setTimeout(() => { provision(debug, runtime, surveyor.surveyorId, 0) }, 5 * 1000)
    }
  }
}

function getVoteRate () {
  return (runtime) => async (request, reply) => {
    const surveyor = await server(request, reply, runtime)
    const voteRate = surveyorsLib.voteValueFromSurveyor(runtime, surveyor, null)

    reply({
      rate: voteRate.toString()
    })
  }
}

async function addSurveyorChoices (runtime, surveyor = <any>{}) {
  const payload = surveyor.payload || {}
  surveyor.payload = payload
  const adFree = payload.adFree || {}
  payload.adFree = adFree
  adFree.choices = await getAdjustedChoices(runtime, 'BAT', ['USD'])
  return surveyor
}

async function getAdjustedChoices (runtime, base, currencies) {
  const rates = await runtime.currency.rates(base, currencies)
  return underscore.mapObject(rates, surveyorChoices)
}

export default {
  enumerate,
  create,
  validate: validateV2,
  routes,
  initialize,
  addSurveyorChoices
}
