const Joi = require('@hapi/joi')
const anonize = require('node-anonize2-relic')
const boom = require('boom')
const bson = require('bson')
const crypto = require('crypto')
const underscore = require('underscore')
const uuidV4 = require('uuid/v4')
const { verify } = require('http-request-signature')

const utils = require('bat-utils')
const braveHapi = utils.extras.hapi
const braveJoi = utils.extras.joi

const v1 = {}
const v2 = {}

let altcurrency

const server = (request, runtime) => {
  const registrarType = request.params.registrarType

  return runtime.registrars[registrarType]
}

/*
   GET /v1/registrar/{registrarType}
   GET /v2/registrar/{registrarType}
 */

v2.read =
{ handler: (runtime) => {
  return async (request, h) => {
    let registrar

    registrar = server(request, runtime)
    if (!registrar) {
      throw boom.notFound('unknown registrar')
    }

    return underscore.extend({ payload: registrar.payload }, registrar.publicInfo())
  }
},

description: 'Returns information about the registrar',
tags: ['api'],

validate:
  { params: {
    registrarType: Joi.string().valid('persona', 'viewing').required().description('the type of the registrar'),
    apiV: Joi.string().required().description('the api version')
  } },

response: {
  schema: Joi.object().keys({
    registrarVK: Joi.string().required().description('public key'),
    payload: Joi.object().required().description('additional information')
  })
}
}

/*
   PATCH /v1/registrar/{registrarType}
   PATCH /v2/registrar/{registrarType}
 */

v2.update =
{ handler: (runtime) => {
  return async (request, h) => {
    const debug = braveHapi.debug(module, request)
    const payload = request.payload || {}
    const registrars = runtime.database.get('registrars', debug)
    let keys, schema, state, registrar, validity

    registrar = server(request, runtime)
    if (!registrar) {
      throw boom.notFound('unknown registrar')
    }

    keys = {}
    keys[altcurrency] = Joi.number().min(1).required()
    schema = {
      persona: Joi.object().keys({ adFree: Joi.object().keys({
        currency: braveJoi.string().altcurrencyCode().optional(),
        days: Joi.number().integer().min(1).max(365).required(),
        fee: Joi.object().keys(keys).unknown(true).required()
      }).unknown(true) }).required()
    }[registrar.registrarType] || Joi.object().max(0)

    validity = Joi.validate(payload, schema)
    if (validity.error) {
      throw boom.badData(validity.error)
    }

    state = { $currentDate: { timestamp: { $type: 'timestamp' } }, $set: { payload: payload } }
    await registrars.update({ registrarId: registrar.registrarId }, state, { upsert: false })

    registrar.payload = payload
    return underscore.extend({ payload: payload }, registrar.publicInfo())
  }
},

auth: {
  strategy: 'session',
  scope: [ 'ledger' ],
  mode: 'required'
},

description: 'Updates a registrar',
tags: [ 'api' ],

validate: {
  params: {
    registrarType: Joi.string().valid('persona', 'viewing').required().description('the type of the registrar'),
    apiV: Joi.string().required().description('the api version')
  },
  payload: Joi.object().optional().description('additional information')
},

response: {
  schema: Joi.object().keys({
    registrarVK: Joi.string().required().description('public key'),
    payload: Joi.object().required().description('additional information')
  })
}
}

/*
   POST /v1/registrar/persona/{uId}
   POST /v2/registrar/persona/{uId}
 */
const createPersona = function (runtime) {
  return async (request, h) => {
    const debug = braveHapi.debug(module, request)
    const uId = request.params.uId.toLowerCase()
    const proof = request.payload.proof
    const response = {}
    const credentials = runtime.database.get('credentials', debug)
    let entry, registrar, state, verification, requestSchema, requestType, validity

    registrar = runtime.registrars['persona']
    if (!registrar) {
      throw boom.notFound('unknown registrar')
    }

    entry = await credentials.findOne({ uId: uId, registrarId: registrar.registrarId })
    if (entry) {
      throw boom.badData('persona credential exists: ' + uId)
    }

    requestType = request.payload.requestType

    if (requestType === 'httpSignature') {
      // TODO consider moving this to a custom joi validator along with signature verif below
      requestSchema = Joi.object().keys({
        headers: Joi.object().keys({
          signature: Joi.string().required(),
          digest: Joi.string().required()
        }).required(),
        body: Joi.object().keys({
          label: Joi.string().required(),
          currency: Joi.string().required(),
          publicKey: Joi.string().required()
        }).required(),
        octets: Joi.string().optional().description('octet string that was signed and digested')
      }).required()
    }
    validity = Joi.validate(request.payload.request, requestSchema)
    if (validity.error) {
      throw boom.badData(validity.error)
    }

    if (requestType === 'httpSignature') {
      const expectedDigest = 'SHA-256=' + crypto.createHash('sha256').update(request.payload.request.octets, 'utf8').digest('base64')
      if (expectedDigest !== request.payload.request.headers.digest) {
        throw boom.badData('the digest specified is not valid for the body provided')
      }

      try {
        const validity = verify({
          headers: request.payload.request.headers,
          publicKey: request.payload.request.body.publicKey
        }, {
          algorithm: 'ed25519'
        })
        if (!validity.verified) {
          throw boom.badData('wallet creation request failed validation, http signature was not valid')
        }
      } catch (e) {
        throw boom.boomify(e)
      }
    }

    const registerEnd = runtime.prometheus.timedRequest('anonizeRegister_request_buckets_milliseconds')
    try {
      verification = registrar.register(proof)
      registerEnd({ erred: false })
    } catch (ex) {
      registerEnd({ erred: true })
      throw boom.badData('invalid registrar proof: ' + JSON.stringify(proof))
    }

    const paymentId = uuidV4().toLowerCase()
    const wallets = runtime.database.get('wallets', debug)
    let result, wallet, requestBody

    requestBody = request.payload.request

    try {
      result = await runtime.wallet.create(requestType, requestBody)
      wallet = result.wallet
    } catch (ex) {
      runtime.captureException(ex, { req: request })
      debug('wallet error', { reason: ex.toString(), stack: ex.stack })
      throw boom.boomify(ex)
    }

    state = {
      $currentDate: { timestamp: { $type: 'timestamp' } },
      $set: underscore.pick(wallet, [ 'addresses', 'provider', 'altcurrency', 'httpSigningPubKey', 'providerId' ])
    }
    await wallets.update({ paymentId: paymentId }, state, { upsert: true })

    await runtime.queue.send(debug, 'persona-report', underscore.extend({ paymentId: paymentId }, state.$set))

    underscore.extend(response, {
      wallet: { paymentId: paymentId, addresses: wallet.addresses },
      payload: registrar.payload
    })

    state = { $currentDate: { timestamp: { $type: 'timestamp' } } }
    await credentials.update({ uId: uId, registrarId: registrar.registrarId }, state, { upsert: true })

    return underscore.extend(response, { verification })
  }
}

/*
   POST /v1/registrar/viewing/{uId}
   POST /v2/registrar/viewing/{uId}
 */
const createViewing = function (runtime) {
  return async (request, h) => {
    const debug = braveHapi.debug(module, request)
    const uId = request.params.uId.toLowerCase()
    const proof = request.payload.proof
    const response = {}
    const credentials = runtime.database.get('credentials', debug)
    let entry, registrar, state, verification

    registrar = runtime.registrars['viewing']
    if (!registrar) {
      throw boom.notFound('unknown registrar')
    }

    entry = await credentials.findOne({ uId: uId, registrarId: registrar.registrarId })
    if (entry) {
      throw boom.badData('viewing credential exists: ' + uId)
    }

    const viewings = runtime.database.get('viewings', debug)
    let diagnostic, surveyorIds, viewing

    viewing = await viewings.findOne({ uId: uId })
    if (!viewing) {
      throw boom.notFound('viewingId not valid: ' + uId)
    }

    surveyorIds = viewing.surveyorIds || []
    if (surveyorIds.length !== viewing.count) {
      diagnostic = 'surveyorIds invalid found ' + surveyorIds.length + ', expecting ' + viewing.count +
                   ', surveyorId=' + viewing.surveyorId
      runtime.captureException(diagnostic, { req: request, extra: { viewing: uId } })

      const resp = boom.serverUnavailable(diagnostic)
      resp.output.headers['retry-after'] = '5'
      throw resp
    }
    underscore.extend(response, { surveyorIds: viewing.surveyorIds })

    try {
      verification = registrar.register(proof)
    } catch (ex) {
      throw boom.badData('invalid registrar proof: ' + JSON.stringify(proof))
    }

    state = { $currentDate: { timestamp: { $type: 'timestamp' } } }
    await credentials.update({ uId: uId, registrarId: registrar.registrarId }, state, { upsert: true })

    return underscore.extend(response, { verification })
  }
}

v2.createViewing =
{ handler: (runtime) => createViewing(runtime),
  description: 'Registers a user viewing',
  tags: ['api'],

  validate: {
    params: {
      uId: Joi.string().hex().length(31).required().description('the universally-unique identifier'),
      apiV: Joi.string().required().description('the api version')
    },
    payload: Joi.object().keys({
      proof: Joi.string().required().description('credential registration request')
    }).unknown(true).required()
  },

  response: {
    schema: Joi.object().keys({
      verification: Joi.string().required().description('credential registration response'),
      surveyorIds: Joi.array().min(1).items(Joi.string()).required().description('allowed surveyors')
    })
  }
}

const keychainSchema = Joi.object().keys({
  xpub: braveJoi.string().Xpub().required(),
  path: Joi.string().optional(),
  encryptedXprv: Joi.string().optional()
})

v1.createPersona =
{ handler: (runtime) => createPersona(runtime, 1),
  description: 'Registers a user persona',
  tags: ['api'],

  validate: {
    params: {
      uId: Joi.string().hex().length(31).required().description('the universally-unique identifier')
    },
    payload: Joi.object().keys({
      proof: Joi.string().required().description('credential registration request'),
      keychains: Joi.object().keys({ user: keychainSchema.required(), backup: keychainSchema.optional() })
    }).unknown(true).required()
  },

  response: {
    schema: Joi.object().keys({
      verification: Joi.string().required().description('credential registration response'),
      wallet: Joi.object().keys({
        paymentId: Joi.string().guid().required().description('opaque identifier for BTC address'),
        address: braveJoi.string().base58().required().description('BTC address')
      }).optional().description('wallet information'),
      payload: Joi.object().optional().description('additional information')
    })
  }
}

v2.createPersona =
{ handler: (runtime) => createPersona(runtime, 2),
  description: 'Registers a user persona',
  tags: ['api'],

  validate: {
    params: {
      uId: Joi.string().hex().length(31).required().description('the universally-unique identifier')
    },
    payload: Joi.object().keys({
      requestType: Joi.string().valid('httpSignature').required().description('the type of the request'),
      request: Joi.object().required().description('wallet registration request'),
      proof: Joi.string().required().description('credential registration request')
    }).unknown(true).required()
  },

  response: {
    schema: Joi.object().keys({
      verification: Joi.string().required().description('credential registration response'),
      wallet: Joi.object().keys({
        paymentId: Joi.string().guid().required().description('opaque identifier for BTC address'),
        addresses: Joi.object().keys({
          BTC: braveJoi.string().altcurrencyAddress('BTC').optional().description('BTC address'),
          BAT: braveJoi.string().altcurrencyAddress('BAT').optional().description('BAT address'),
          CARD_ID: Joi.string().guid().optional().description('Card id'),
          ETH: braveJoi.string().altcurrencyAddress('ETH').optional().description('ETH address'),
          LTC: braveJoi.string().altcurrencyAddress('LTC').optional().description('LTC address')
        })
      }).optional().description('wallet information'),
      payload: Joi.object().optional().description('additional information')
    })
  }
}

module.exports.routes = [
  braveHapi.routes.async().path('/{apiV}/registrar/{registrarType}').config(v2.read),
  braveHapi.routes.async().patch().path('/{apiV}/registrar/{registrarType}').config(v2.update),
  braveHapi.routes.async().post().path('/v1/registrar/persona/{uId}').config(v1.createPersona),
  braveHapi.routes.async().post().path('/v2/registrar/persona/{uId}').config(v2.createPersona),
  braveHapi.routes.async().post().path('/{apiV}/registrar/viewing/{uId}').config(v2.createViewing)
]

module.exports.initialize = async (debug, runtime) => {
  const configurations = process.env.REGISTRARS || 'persona:1,viewing:2'
  const registrars = runtime.database.get('registrars', debug)
  let entry, i, payload, registrar, registrarId, registrarType, service, services, state

  altcurrency = runtime.config.altcurrency || 'BAT'

  await runtime.database.checkIndices(debug, [
    {
      category: registrars,
      name: 'registrars',
      property: 'registrarId',
      empty: { registrarId: '', registrarType: '', payload: {}, timestamp: bson.Timestamp.ZERO },
      unique: [ { registrarId: 1 } ],
      others: [ { registrarType: 1 }, { timestamp: 1 } ]
    },
    {
      category: runtime.database.get('credentials', debug),
      name: 'credentials',
      property: 'registrarId_1_uId',
      empty: { uId: '', registrarId: 0, timestamp: bson.Timestamp.ZERO },
      unique: [ { registrarId: 1, uId: 1 } ],
      others: [ { timestamp: 1 } ]
    }
  ])

  await runtime.queue.create('persona-report')

  runtime.registrars = []

  services = configurations.split(',')
  for (i = services.length - 1; i >= 0; i--) {
    service = services[i].split(':')
    registrarType = service[0]
    registrarId = parseInt(service[1], 10)

    entry = await registrars.findOne({ registrarId: registrarId })
    if (entry) {
      if (entry.registrarType !== registrarType) {
        throw new Error('registrar #' + registrarId + ': mismatch, expecting ' + registrarType + ', found ' +
                        entry.registrarType)
      }
      registrar = new anonize.Registrar(entry.parameters)
      payload = entry.payload
    } else {
      registrar = new anonize.Registrar()
      payload = (registrarType === 'persona') ? { adFree: { fee: { USD: 5.00 }, days: 30 } } : {}
      state = {
        $currentDate: { timestamp: { $type: 'timestamp' } },
        $set: underscore.extend({ registrarType: registrarType, payload: payload }, registrar)
      }
      await registrars.update({ registrarId: registrarId }, state, { upsert: true })
    }

    registrar.registrarId = registrarId
    registrar.registrarType = registrarType
    registrar.payload = payload
    runtime.registrars[registrarType] = registrar
  }
}
