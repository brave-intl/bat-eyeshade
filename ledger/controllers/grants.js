const Joi = require('joi')
const Netmask = require('netmask').Netmask
const l10nparser = require('accept-language-parser')
const boom = require('boom')
const bson = require('bson')
const underscore = require('underscore')
const uuid = require('uuid')
const wreck = require('wreck')

const utils = require('bat-utils')
const braveJoi = utils.extras.joi
const braveHapi = utils.extras.hapi
const braveUtils = utils.extras.utils
const whitelist = utils.hapi.auth.whitelist

const rateLimitEnabled = process.env.NODE_ENV === 'production'
const unnecessaryPromotionDetails = [ '_id', 'priority', 'active', 'count', 'batchId', 'timestamp' ]

const qalist = { addresses: process.env.IP_QA_WHITELIST && process.env.IP_QA_WHITELIST.split(',') }

const claimRate = {
  limit: process.env.GRANT_CLAIM_RATE ? Number(process.env.GRANT_CLAIM_RATE) : 50,
  window: process.env.GRANT_CLAIM_WINDOW ? Number(process.env.GRANT_CLAIM_WINDOW) : 3 * 60 * 60
}

const captchaRate = {
  limit: process.env.GRANT_CLAIM_RATE ? Number(process.env.GRANT_CLAIM_RATE) : 50,
  window: process.env.GRANT_CLAIM_WINDOW ? Number(process.env.GRANT_CLAIM_WINDOW) : 3 * 60 * 60
}

if (qalist.addresses) {
  qalist.authorizedAddrs = []
  qalist.authorizedBlocks = []

  qalist.addresses.forEach((entry) => {
    if ((entry.indexOf('/') === -1) && (entry.split('.').length === 4)) return qalist.authorizedAddrs.push(entry)

    qalist.authorizedBlocks.push(new Netmask(entry))
  })
}

const qaOnlyP = (request) => {
  const ipaddr = whitelist.ipaddr(request)

  return (qalist.authorizedAddrs) && (qalist.authorizedAddrs.indexOf(ipaddr) === -1) &&
    (!underscore.find(qalist.authorizedBlocks, (block) => { return block.contains(ipaddr) }))
}

const rateLimitPlugin = {
  enabled: rateLimitEnabled && !qalist.addresses,
  rate: (request) => captchaRate
}
const joiBraveProductEnum = Joi.string().valid(['browser-laptop', 'brave-core']).default('browser-laptop').optional().description('the brave product requesting the captcha')
const grantTypeValidator = Joi.string().allow(['ugp', 'ads']).default('ugp').description('the type of grant to use')
const grantProviderIdValidator = Joi.string().guid().when('type', {
  is: 'ads',
  then: Joi.required(),
  otherwise: Joi.forbidden()
})
const joiPaymentId = Joi.string().guid().required().description('identity of the wallet')
const joiPromotionId = Joi.string().required().description('the promotion-identifier')
const captchaResponseStructure = Joi.object().optional().keys({
  x: Joi.number().required(),
  y: Joi.number().required()
})
const grantSchema = Joi.object().keys({
  grantId: Joi.string().guid().required().description('the grant-identifier'),
  promotionId: Joi.string().guid().required().description('the associated promotion'),
  altcurrency: braveJoi.string().altcurrencyCode().required().description('the grant altcurrency'),
  probi: braveJoi.string().numeric().required().description('the grant amount in probi'),
  maturityTime: Joi.number().positive().required().description('the time the grant becomes redeemable'),
  expiryTime: Joi.number().positive().required().description('the time the grant expires')
})
const grantContentV4Validator = grantSchema.keys({
  type: grantTypeValidator,
  providerId: grantProviderIdValidator
})
const publicGrantValidator = Joi.object().keys({
  altcurrency: braveJoi.string().altcurrencyCode().optional().default('BAT').description('the grant altcurrency'),
  expiryTime: Joi.number().optional().description('the expiration time of the grant'),
  probi: braveJoi.string().numeric().optional().description('the grant amount in probi')
}).unknown(true).description('grant properties')
const publicGrantV4Validator = publicGrantValidator.keys({
  type: grantTypeValidator,
  providerId: grantProviderIdValidator
})

const v1 = {}
const v2 = {}
const v3 = {}
const v4 = {}

/*
   GET /v2/promotions
   GET /v3/promotions
 */

const getPromotions = (protocolVersion) => (runtime) => async (request, reply) => {
  const debug = braveHapi.debug(module, request)
  const promotions = runtime.database.get('promotions', debug)
  let entries, where, projection

  if (qaOnlyP(request)) {
    return reply(boom.notFound())
  }

  where = {
    protocolVersion,
    promotionId: { $ne: '' }
  }

  projection = {
    sort: { priority: 1 },
    fields: {
      _id: 0,
      batchId: 0,
      timestamp: 0
    }
  }
  entries = await promotions.find(where, projection)

  reply(entries)
}

/*
 GET /v3/promotions
*/

const safetynetPassthrough = (handler) => (runtime) => async (request, reply) => {
  const endpoint = '/v1/attestations/safetynet'
  const {
    config
  } = runtime
  const {
    captcha
  } = config

  const url = captcha.url + endpoint
  const headers = {
    'Authorization': 'Bearer ' + captcha.access_token,
    'Content-Type': 'application/json'
  }
  const body = JSON.stringify({
    token: request.headers['safetynet-token']
  })

  try {
    await braveHapi.wreck.post(url, {
      headers,
      payload: body
    })

    await handler(runtime)(request, reply)
  } catch (ex) {
    try {
      const errPayload = JSON.parse(ex.data.payload.toString())
      return reply(boom.notFound(errPayload.message))
    } catch (ex) {
      runtime.captureException(ex, { req: request })
    }
    return reply(boom.notFound())
  }
}

const promotionsGetResponseSchema = Joi.array().min(0).items(Joi.object().keys({
  promotionId: Joi.string().required().description('the promotion-identifier')
}).unknown(true).description('promotion properties'))

v2.all = {
  handler: getPromotions(2),
  description: 'See if a v2 promotion is available',
  tags: [ 'api' ],

  validate: { query: {} },

  response: {
    schema: promotionsGetResponseSchema
  }
}

v3.all = {
  handler: getPromotions(3),
  description: 'See if a v3 promotion is available',
  tags: [ 'api' ],

  validate: {},

  response: {
    schema: promotionsGetResponseSchema
  }
}

v4.all = {
  handler: getPromotions(4),
  description: 'See if a v4 promotion is available',
  tags: [ 'api' ],

  validate: {},

  response: {
    schema: promotionsGetResponseSchema
  }
}

/*
   GET /v2/grants
   GET /v3/grants
 */

// from https://github.com/opentable/accept-language-parser/blob/master/index.js#L1
const localeRegExp = /((([a-zA-Z]+(-[a-zA-Z0-9]+){0,2})|\*)(;q=[0-1](\.[0-9]+)?)?)*/g
const getGrant = (protocolVersion) => (runtime) => {
  return async (request, reply) => {
    // Only support requests from Chrome versions > 70
    if (protocolVersion === 2) {
      let userAgent = request.headers['user-agent']
      let userAgentIsChrome = userAgent.split('Chrome/').length > 1
      if (userAgentIsChrome) {
        let chromeVersion = parseInt(userAgent.split('Chrome/')[1].substring(0, 2))
        if (chromeVersion < 70) {
          return reply(boom.notFound('promotion not available for browser-laptop.'))
        }
      }
    }

    const lang = request.query.lang
    const paymentId = request.query.paymentId
    const languages = l10nparser.parse(lang)
    const query = {
      active: true,
      count: { $gt: 0 },
      protocolVersion
    }
    const debug = braveHapi.debug(module, request)
    const grants = runtime.database.get('grants', debug)
    const promotions = runtime.database.get('promotions', debug)
    const wallets = runtime.database.get('wallets', debug)
    let candidates, entries, priority, promotion, promotionIds

    const l10n = (o) => {
      const labels = [ 'greeting', 'message', 'text' ]

      for (let key in o) {
        let f = {
          object: () => {
            l10n(o[key])
          },
          string: () => {
            if ((labels.indexOf(key) === -1) && !(key.endsWith('Button') || key.endsWith('Markup') || key.endsWith('Text'))) {
//            return
            }

            // TBD: localization here...
          }
        }[typeof o[key]]
        if (f) f()
      }
    }

    if (qaOnlyP(request)) return reply(boom.notFound())

    if (paymentId) {
      promotionIds = []
      const wallet = await wallets.findOne({ paymentId: paymentId })
      if (!wallet) return reply(boom.notFound('no such wallet: ' + paymentId))
      if (wallet.grants) {
        wallet.grants.forEach((grant) => { promotionIds.push(grant.promotionId) })
      }
      underscore.extend(query, { promotionId: { $nin: promotionIds } })
    }

    entries = await promotions.find(query)
    if ((!entries) || (!entries[0])) return reply(boom.notFound('no promotions available'))

    candidates = []
    priority = Number.POSITIVE_INFINITY
    entries.forEach((entry) => {
      if (entry.priority > priority) return

      if (priority < entry.priority) {
        candidates = []
        priority = entry.priority
      }
      candidates.push(entry)
    })
    promotion = underscore.shuffle(candidates)[0]

    const counted = await grants.count({
      promotionId: promotion.promotionId
    })
    if (counted === 0) {
      return reply(boom.notFound('promotion not available'))
    }

    debug('grants', { languages: languages })
    l10n(promotion)

    reply(underscore.omit(promotion, [ '_id', 'priority', 'active', 'count', 'batchId', 'timestamp' ]))
  }
}

v2.read = {
  handler: getGrant(2),
  description: 'See if a v2 promotion is available',
  tags: [ 'api' ],
  validate: {
    headers: Joi.object().keys({
      'user-agent': Joi.string().required().description('the browser user agent')
    }).unknown(true),
    query: {
      lang: Joi.string().regex(localeRegExp).optional().default('en').description('the l10n language'),
      paymentId: Joi.string().guid().optional().description('identity of the wallet')
    }
  },

  response: {
    schema: Joi.object().keys({
      promotionId: Joi.string().required().description('the promotion-identifier')
    }).unknown(true).description('promotion properties')
  }
}

v3.read = {
  handler: safetynetPassthrough(getGrant(3)),
  description: 'See if a v3 promotion is available',
  tags: [ 'api' ],

  validate: {
    headers: Joi.object().keys({
      'safetynet-token': Joi.string().required().description('the safetynet token created by the android device')
    }).unknown(true),
    query: {
      lang: Joi.string().regex(localeRegExp).optional().default('en').description('the l10n language'),
      paymentId: Joi.string().guid().optional().description('identity of the wallet')
    }
  },

  response: {
    schema: Joi.object().keys({
      promotionId: Joi.string().required().description('the promotion-identifier')
    }).unknown(true).description('promotion properties')
  }
}

/*
  GET /v4/grants
*/

v4.read = {
  handler: getGrantV4(4, chooseFromAvailablePromotionsByType),
  description: 'See if a v4 promotion is available',
  tags: [ 'api' ],

  validate: {
    query: {
      lang: Joi.string().regex(localeRegExp).optional().default('en').description('the l10n language'),
      paymentId: Joi.string().guid().optional().description('identity of the wallet')
    }
  },

  response: {
    schema: Joi.object().keys({
      grants: Joi.array().items(Joi.object().keys({
        promotionId: Joi.string().required().description('the promotion-identifier')
      }).unknown(true).description('promotion properties'))
    })
  }
}

const checkBounds = (v1, v2, tol) => {
  if (v1 > v2) {
    return (v1 - v2) <= tol
  } else {
    return (v2 - v1) <= tol
  }
}

/*
   PUT /v2/grants/{paymentId}
 */

v2.claimGrant = {
  handler: claimGrant(captchaCheck),
  description: 'Request a grant for a wallet',
  tags: [ 'api' ],

  plugins: {
    rateLimit: {
      enabled: rateLimitEnabled,
      rate: (request) => claimRate
    }
  },

  validate: {
    params: { paymentId: Joi.string().guid().required().description('identity of the wallet') },
    payload: Joi.object().keys({
      promotionId: Joi.string().required().description('the promotion-identifier'),
      captchaResponse: Joi.object().optional().keys({
        x: Joi.number().required(),
        y: Joi.number().required()
      })
    }).required().description('promotion derails')
  },

  response: {
    schema: publicGrantValidator
  }
}

/*
   PUT /v3/grants/{paymentId}
 */

v3.claimGrant = {
  handler: claimGrant(safetynetCheck),
  description: 'Request a grant for a wallet',
  tags: [ 'api' ],

  plugins: {
    rateLimit: {
      enabled: rateLimitEnabled,
      rate: (request) => claimRate
    }
  },

  validate: {
    params: {
      paymentId: Joi.string().guid().required().description('identity of the wallet')
    },
    headers: Joi.object().keys({
      'safetynet-token': Joi.string().required().description('the safetynet token created by the android device')
    }).unknown(true),
    payload: Joi.object().keys({
      promotionId: Joi.string().required().description('the promotion-identifier')
    }).required().description('promotion details')
  },

  response: {
    schema: publicGrantV4Validator
  }
}

/*
   PUT /v4/grants/{paymentId}
 */

v4.claimGrant = {
  handler: claimGrant(captchaCheck, v4CreateGrantQuery),
  description: 'Request a grant for a wallet',
  tags: [ 'api' ],

  plugins: {
    rateLimit: {
      enabled: rateLimitEnabled,
      rate: (request) => claimRate
    }
  },

  validate: {
    params: Joi.object().keys({
      paymentId: joiPaymentId
    }),
    payload: Joi.object().keys({
      promotionId: joiPromotionId,
      captchaResponse: captchaResponseStructure
    }).required().description('promotion details')
  },

  response: {
    schema: publicGrantV4Validator
  }
}

function claimGrant (validate, createGrantQuery = defaultCreateGrantQuery) {
  return (runtime) => async (request, reply) => {
    const {
      params,
      payload
    } = request
    let { paymentId } = params
    paymentId = paymentId.toLowerCase()
    const { promotionId } = payload
    const debug = braveHapi.debug(module, request)
    const grants = runtime.database.get('grants', debug)
    const promotions = runtime.database.get('promotions', debug)
    const wallets = runtime.database.get('wallets', debug)
    let grant, result, state, wallet

    if (!runtime.config.redeemer) return reply(boom.badGateway('not configured for promotions'))

    const promotion = await promotions.findOne({ promotionId: promotionId })
    if (!promotion) return reply(boom.notFound('no such promotion: ' + promotionId))
    if (!promotion.active) return reply(boom.notFound('promotion is not active: ' + promotionId))

    wallet = await wallets.findOne({ paymentId: paymentId })
    if (!wallet) return reply(boom.notFound('no such wallet: ' + paymentId))

    const validationError = await validate(debug, runtime, request, promotion, wallet)
    if (validationError) {
      return reply(validationError)
    }

    if (wallet.grants && wallet.grants.some(x => x.promotionId === promotionId)) {
      // promotion already applied to wallet
      return reply(boom.conflict())
    }

    // pop off one grant
    const grantQuery = createGrantQuery(promotion, wallet)
    grant = await grants.findOneAndDelete(grantQuery)
    if (!grant) return reply(boom.resourceGone('promotion no longer available'))

    const grantProperties = ['token', 'grantId', 'promotionId', 'status', 'type', 'paymentId']
    const grantSubset = underscore.pick(grant, grantProperties)
    const currentProperties = {
      claimTimestamp: Date.now(),
      claimIP: whitelist.ipaddr(request)
    }
    const grantInfo = underscore.extend(grantSubset, currentProperties)

    // atomic find & update, only one request is able to add a grant for the given promotion to this wallet
    wallet = await wallets.findOneAndUpdate({ 'paymentId': paymentId, 'grants.promotionId': { '$ne': promotionId } },
                            { $push: { grants: grantInfo } }
    )
    if (!wallet) {
      // reinsert grant, another request already added a grant for this promotion to the wallet
      await grants.insert(grant)
      // promotion already applied to wallet
      return reply(boom.conflict())
    }

    // register the users claim to the grant with the redemption server
    const walletPayload = { wallet: underscore.pick(wallet, ['altcurrency', 'provider', 'providerId']) }
    try {
      result = await braveHapi.wreck.put(runtime.config.redeemer.url + '/v1/grants/' + grant.grantId, {
        headers: {
          'Authorization': 'Bearer ' + runtime.config.redeemer.access_token,
          'Content-Type': 'application/json',
          // Only pass "trusted" IP, not previous value of X-Forwarded-For
          'X-Forwarded-For': whitelist.ipaddr(request),
          'User-Agent': request.headers['user-agent']
        },
        payload: JSON.stringify(walletPayload),
        useProxyP: true
      })
    } catch (ex) {
      runtime.captureException(ex, { req: request })
    }

    if (runtime.config.balance) {
      // invalidate any cached balance
      try {
        await braveHapi.wreck.delete(runtime.config.balance.url + '/v2/wallet/' + paymentId + '/balance',
          {
            headers: {
              authorization: 'Bearer ' + runtime.config.balance.access_token,
              'content-type': 'application/json'
            },
            useProxyP: true
          })
      } catch (ex) {
        runtime.captureException(ex, { req: request })
      }
    }

    state = {
      $currentDate: { timestamp: { $type: 'timestamp' } },
      $inc: { count: -1 }
    }
    await promotions.update({ promotionId: promotionId }, state, { upsert: true })

    const grantContent = braveUtils.extractJws(grant.token)

    result = underscore.pick(grantContent, [ 'altcurrency', 'probi', 'expiryTime', 'type', 'providerId' ])
    await runtime.queue.send(debug, 'grant-report', underscore.extend({
      grantId: grantContent.grantId,
      paymentId: paymentId,
      promotionId: promotionId
    }, result))

    return reply(result)
  }
}

async function safetynetCheck (debug, runtime, request, promotion, wallet) {
  const {
    config,
    database
  } = runtime
  const {
    captcha
  } = config
  const {
    headers
  } = request
  const {
    paymentId
  } = wallet
  const url = `${captcha.url}/v1/attestations/safetynet`
  const captchaHeaders = {
    'Authorization': 'Bearer ' + captcha.access_token,
    'Content-Type': 'application/json'
  }
  const wallets = database.get('wallets', debug)
  const body = JSON.stringify({
    token: headers['safetynet-token']
  })

  const payload = await braveHapi.wreck.post(url, {
    headers: captchaHeaders,
    payload: body
  })
  const data = JSON.parse(payload.toString())

  await wallets.findOneAndUpdate({
    paymentId
  }, {
    $unset: {
      nonce: {}
    }
  })

  if (wallet.nonce !== data.nonce) {
    return boom.forbidden('safetynet nonce does not match')
  }
}

async function captchaCheck (debug, runtime, request, promotion, wallet) {
  const { captchaResponse } = request.payload
  const { paymentId } = wallet
  const wallets = runtime.database.get('wallets', debug)
  const configCaptcha = runtime.config.captcha
  if (configCaptcha) {
    if (!wallet.captcha) return boom.forbidden('must first request captcha')
    if (!captchaResponse) return boom.badData()

    await wallets.findOneAndUpdate({ 'paymentId': paymentId }, { $unset: { captcha: {} } })
    console.log(wallet.captcha, promotion)
    if (wallet.captcha.version) {
      if (wallet.captcha.version !== promotion.protocolVersion) {
        return boom.forbidden('must first request correct captcha version')
      }
    } else {
      if (promotion.protocolVersion !== 2) {
        return boom.forbidden('must first request correct captcha version')
      }
    }

    if (!(checkBounds(wallet.captcha.x, captchaResponse.x, 5) && checkBounds(wallet.captcha.y, captchaResponse.y, 5))) {
      return boom.forbidden()
    }
  }
}

const promotionIdValidator = Joi.string().required().description('the promotion-identifier')
const priorityValidator = Joi.number().integer().min(0).required().description('the promotion priority (lower is better)')
const activeValidator = Joi.boolean().optional().default(true).description('the promotion status')
const protocolVersionValidator = Joi.number().integer().min(2).required().description('the protocol version that the promotion will follow')
const promotionValidator = Joi.object().keys({
  promotionId: promotionIdValidator,
  priority: priorityValidator,
  active: activeValidator
}).unknown(true).description('promotions for bulk upload')
const promotionsValidator = Joi.array().min(0).items(promotionValidator)
const grantValidator = Joi.string().required().description('the jws encoded grant')
const grantsValidator = Joi.array().min(0).items(grantValidator).description('grants for bulk upload')
const grantsUploadSchema = Joi.object().keys({
  grants: grantsValidator,
  promotions: promotionsValidator
}).required().description('data for bulk upload')
const promotionV4Validator = promotionValidator.keys({
  protocolVersion: protocolVersionValidator,
  minimumReconcileTimestamp: Joi.number().optional().description('time when the promotion can be reconciled')
})
const promotionsV4Validator = Joi.array().min(0).items(promotionV4Validator)
const grantsUploadV4Validator = grantsUploadSchema.keys({
  grants: grantsValidator,
  promotions: promotionsV4Validator
})

/*
   POST /v2/grants
*/

const uploadGrants = (protocolVersion) => (runtime) => {
  return async (request, reply) => {
    const batchId = uuid.v4().toLowerCase()
    const debug = braveHapi.debug(module, request)
    const grants = runtime.database.get('grants', debug)
    const promotions = runtime.database.get('promotions', debug)
    let state

    let payload = request.payload

    if (payload.file) {
      payload = payload.file
      const validity = Joi.validate(payload, grantsUploadSchema)
      if (validity.error) {
        return reply(boom.badData(validity.error))
      }
    }

    const grantsToInsert = []
    const promotionCounts = {}
    for (let entry of payload.grants) {
      const grantContent = braveUtils.extractJws(entry)
      const validity = Joi.validate(grantContent, grantSchema)
      if (validity.error) {
        return reply(boom.badData(validity.error))
      }
      grantsToInsert.push({ grantId: grantContent.grantId, token: entry, promotionId: grantContent.promotionId, status: 'active', batchId: batchId })
      if (!promotionCounts[grantContent.promotionId]) {
        promotionCounts[grantContent.promotionId] = 0
      }
      promotionCounts[grantContent.promotionId]++
    }

    await grants.insert(grantsToInsert)

    for (let entry of payload.promotions) {
      let $set = underscore.assign({
        protocolVersion
      }, underscore.omit(entry, ['promotionId']))
      let { promotionId } = entry
      state = {
        $set,
        $currentDate: { timestamp: { $type: 'timestamp' } },
        $inc: { count: promotionCounts[promotionId] }
      }
      await promotions.update({
        promotionId
      }, state, { upsert: true })
    }

    reply({})
  }
}

v1.create =
{ handler: uploadGrants(1),

  auth: {
    strategy: 'session',
    scope: [ 'ledger' ],
    mode: 'required'
  },

  description: 'Create one or more grants',
  tags: [ 'api' ],

  validate: { payload: grantsUploadSchema },

  payload: { output: 'data', maxBytes: 1024 * 1024 * 20 },

  response:
    { schema: Joi.object().length(0) }
}

v2.create =
{ handler: uploadGrants(2),

  auth: {
    strategy: 'session',
    scope: [ 'ledger' ],
    mode: 'required'
  },

  description: 'Create one or more grants via file upload',
  tags: [ 'api' ],

  plugins: {
    'hapi-swagger': {
      payloadType: 'form',
      validate: {
        payload: {
          file: Joi.any()
                      .meta({ swaggerType: 'file' })
                      .description('json file')
        }
      }
    }
  },

  validate: { headers: Joi.object({ authorization: Joi.string().optional() }).unknown() },
  payload: { output: 'data', maxBytes: 1024 * 1024 * 20 },

  response:
    { schema: Joi.object().length(0) }
}

/*
  POST /v3/grants
*/

v3.create =
{ handler: uploadV4Grants(grantsUploadV4Validator, grantContentV4Validator),

  auth: {
    strategy: 'session',
    scope: [ 'ledger' ],
    mode: 'required'
  },

  description: 'Create one or more grants via file upload',
  tags: [ 'api' ],

  plugins: {
    'hapi-swagger': {
      payloadType: 'form',
      validate: {
        payload: {
          file: Joi.any()
                      .meta({ swaggerType: 'file' })
                      .description('json file')
        }
      }
    }
  },

  validate: { headers: Joi.object({ authorization: Joi.string().optional() }).unknown() },
  payload: { output: 'data', maxBytes: 1024 * 1024 * 20 },

  response:
    { schema: Joi.object().length(0) }
}

const cohortsAssignmentSchema = Joi.array().min(0).items(Joi.object().keys({
  paymentId: Joi.string().guid().required().description('identity of the wallet'),
  cohort: Joi.string().required().description('cohort to assign')
}).unknown(true).description('grant cohorts'))

/*
   PUT /v2/grants/cohorts
 */

v2.cohorts = { handler: (runtime) => {
  return async (request, reply) => {
    const debug = braveHapi.debug(module, request)
    const wallets = runtime.database.get('wallets', debug)

    let payload = request.payload

    if (payload.file) {
      payload = payload.file
      const validity = Joi.validate(payload, cohortsAssignmentSchema)
      if (validity.error) {
        return reply(boom.badData(validity.error))
      }
    }

    for (let entry of payload) {
      await wallets.update({ 'paymentId': entry.paymentId }, { $set: { 'cohort': entry.cohort } })
    }

    return reply({})
  }
},
  description: 'Set cohort associated with grants on a wallet for testing',
  tags: [ 'api' ],
  auth: {
    strategy: 'session',
    scope: [ 'ledger' ],
    mode: 'required'
  },

  plugins: {
    'hapi-swagger': {
      payloadType: 'form',
      validate: {
        payload: {
          file: Joi.any()
                      .meta({ swaggerType: 'file' })
                      .description('json file')
        }
      }
    }
  },

  validate: { headers: Joi.object({ authorization: Joi.string().optional() }).unknown() },
  payload: { output: 'data', maxBytes: 1024 * 1024 * 20 },

  response: { schema: Joi.object().length(0) }
}

/*
   GET /v2/captchas/{paymentId}
   GET /v4/captchas/{paymentId}
 */

const getCaptcha = (protocolVersion) => (runtime) => {
  return async (request, reply) => {
    const paymentId = request.params.paymentId.toLowerCase()
    const debug = braveHapi.debug(module, request)
    const wallets = runtime.database.get('wallets', debug)

    if (!runtime.config.captcha) return reply(boom.notFound())
    if (qaOnlyP(request)) return reply(boom.notFound())

    const wallet = await wallets.findOne({ 'paymentId': paymentId })
    if (!wallet) return reply(boom.notFound('no such wallet: ' + paymentId))

    const productEndpoints = {
      'brave-core': {
        2: '/v2/captchas/variableshapetarget',
        4: '/v2/captchas/variableshapetarget'
      }
    }

    const braveProduct = request.headers['brave-product'] || 'browser-laptop'
    const captchaEndpoints = productEndpoints[braveProduct]
    if (!captchaEndpoints) {
      return reply(boom.notFound('no captcha endpoints'))
    }

    const endpoint = captchaEndpoints[protocolVersion]
    if (!endpoint) {
      return reply(boom.notFound('no protocol version'))
    }

    const { res, payload } = await wreck.get(runtime.config.captcha.url + endpoint, {
      headers: {
        'Authorization': 'Bearer ' + runtime.config.captcha.access_token,
        'Content-Type': 'application/json',
        'X-Forwarded-For': whitelist.ipaddr(request)
      }
    })

    const { headers } = res

    const solution = JSON.parse(headers['captcha-solution'])
    await wallets.findOneAndUpdate({ 'paymentId': paymentId }, { $set: { captcha: underscore.extend(solution, {version: protocolVersion}) } })

    return reply(payload).header('Content-Type', headers['content-type']).header('Captcha-Hint', headers['captcha-hint'])
  }
}

v2.getCaptcha = {
  handler: getCaptcha(2),
  description: 'Get a claim time captcha',
  tags: [ 'api' ],

  plugins: {
    rateLimit: rateLimitPlugin
  },

  validate: {
    params: {
      paymentId: joiPaymentId
    },
    headers: Joi.object().keys({
      'brave-product': joiBraveProductEnum
    }).unknown(true).description('headers')
  }
}

v4.getCaptcha = {
  handler: getCaptcha(4),
  description: 'Get a claim time v4 captcha',
  tags: [ 'api' ],

  plugins: {
    rateLimit: rateLimitPlugin
  },

  validate: {
    params: {
      paymentId: joiPaymentId
    },
    headers: Joi.object().keys({
      'brave-product': joiBraveProductEnum
    }).unknown(true).description('headers')
  }
}

/*
  GET /v1/attestations/{paymentId}
*/

v3.attestations = {
  description: 'Retrieve nonce for android attestation',
  tags: [ 'api' ],
  response: {
    schema: Joi.object().keys({
      nonce: Joi.string().required().description('Nonce for wallet')
    }).required().description('Response payload')
  },
  validate: {
    params: Joi.object().keys({
      paymentId: Joi.string().guid().required().description('Wallet payment id')
    }).required().description('Request parameters')
  },
  handler: (runtime) => async (request, reply) => {
    const { paymentId } = request.params
    const { database } = runtime

    const debug = braveHapi.debug(module, request)
    const wallets = database.get('wallets', debug)

    const nonce = uuid.v4()

    const $set = {
      nonce: Buffer.from(nonce).toString('base64')
    }

    await wallets.update({
      paymentId
    }, {
      $set
    })

    reply({
      nonce
    })
  }
}

module.exports.routes = [
  braveHapi.routes.async().path('/v2/promotions').config(v2.all),
  braveHapi.routes.async().path('/v3/promotions').config(v3.all),
  braveHapi.routes.async().path('/v2/grants').config(v2.read),
  braveHapi.routes.async().path('/v3/grants').config(v3.read),
  braveHapi.routes.async().path('/v4/grants').config(v4.read),
  braveHapi.routes.async().put().path('/v2/grants/{paymentId}').config(v2.claimGrant),
  braveHapi.routes.async().put().path('/v3/grants/{paymentId}').config(v3.claimGrant),
  braveHapi.routes.async().put().path('/v4/grants/{paymentId}').config(v4.claimGrant),
  braveHapi.routes.async().post().path('/v1/grants').config(v1.create),
  braveHapi.routes.async().post().path('/v2/grants').config(v2.create),
  braveHapi.routes.async().post().path('/v3/grants').config(v3.create),
  braveHapi.routes.async().path('/v1/attestations/{paymentId}').config(v3.attestations),
  braveHapi.routes.async().put().path('/v2/grants/cohorts').config(v2.cohorts),
  braveHapi.routes.async().path('/v2/captchas/{paymentId}').config(v2.getCaptcha),
  braveHapi.routes.async().path('/v4/captchas/{paymentId}').config(v4.getCaptcha)
]

module.exports.initialize = async (debug, runtime) => {
  runtime.database.checkIndices(debug, [
    {
      category: runtime.database.get('grants', debug),
      name: 'grants',
      property: 'grantId',
      empty: {
        token: '',

        // duplicated from "token" for unique
        grantId: '',
        // duplicated from "token" for filtering
        promotionId: '',

        status: '', // active, completed, expired

        batchId: '',
        timestamp: bson.Timestamp.ZERO
      },
      unique: [ { grantId: 1 } ],
      others: [ { promotionId: 1 }, { altcurrency: 1 }, { probi: 1 },
                { status: 1 },
                { batchId: 1 }, { timestamp: 1 } ]
    },
    {
      category: runtime.database.get('promotions', debug),
      name: 'promotions',
      property: 'promotionId',
      empty: {
        promotionId: '',
        priority: 99999,

        active: false,
        count: 0,

        batchId: '',
        timestamp: bson.Timestamp.ZERO,

        protocolVersion: 2
      },
      unique: [ { promotionId: 1 } ],
      others: [ { active: 1 }, { count: 1 },
                { batchId: 1 }, { timestamp: 1 },
                { protocolVersion: 2 } ]
    }
  ])

  await runtime.queue.create('grant-report')
  await runtime.queue.create('redeem-report')
}

function defaultCreateGrantQuery ({
  promotionId
}) {
  return {
    status: 'active',
    promotionId
  }
}

function v4CreateGrantQuery ({
  promotionId,
  type
}, {
  addresses
}) {
  const query = {
    type: 'ugp',
    status: 'active',
    promotionId
  }
  if (type === 'ads') {
    Object.assign(query, {
      type,
      providerId: addresses.CARD_ID
    })
  }
  return query
}

async function chooseFromAvailablePromotions (debug, runtime, {
  entries
}) {
  let priority = Number.POSITIVE_INFINITY
  const candidates = entries.reduce((memo, entry) => {
    let candidates = memo
    if (entry.priority > priority) {
      return candidates
    }
    if (priority < entry.priority) {
      candidates = []
      priority = entry.priority
    }
    return candidates.concat(entry)
  }, [])
  if (!candidates.length) {
    return candidates
  }

  const promotion = underscore.shuffle(candidates)[0]
  return underscore.omit(promotion, unnecessaryPromotionDetails)
}

async function chooseFromAvailablePromotionsByType (debug, runtime, {
  entries,
  type
}) {
  const ads = underscore.filter(entries, ({
    type
  }) => type === 'ads')
  const ugp = underscore.filter(entries, ({
    type
  }) => {
    return type === '' || type == null || type === 'ugp'
  })
  const adsPromotions = await chooseFromAvailablePromotions(debug, runtime, {
    entries: ads
  })
  const ugpPromotions = await chooseFromAvailablePromotions(debug, runtime, {
    entries: ugp
  })
  return adsPromotions.concat(ugpPromotions)
}

function getGrantV4 (protocolVersion, createPayload) {
  return (runtime) => async (request, reply) => {
    const {
      paymentId,
      type
    } = request.query
    const query = {
      active: true,
      count: { $gt: 0 },
      protocolVersion
    }
    const debug = braveHapi.debug(module, request)
    const grants = runtime.database.get('grants', debug)
    const promotions = runtime.database.get('promotions', debug)
    const wallets = runtime.database.get('wallets', debug)

    if (qaOnlyP(request)) {
      return reply(boom.notFound())
    }

    if (paymentId) {
      const promotionIds = []
      const wallet = await wallets.findOne({ paymentId: paymentId })
      if (!wallet) {
        return reply(boom.notFound('no such wallet: ' + paymentId))
      }
      if (wallet.grants) {
        wallet.grants.forEach((grant) => { promotionIds.push(grant.promotionId) })
      }
      underscore.extend(query, { promotionId: { $nin: promotionIds } })
    }

    const entries = await promotions.find(query)
    if (!entries || !entries[0]) {
      return reply(boom.notFound('no promotions available'))
    }

    const result = await createPayload(debug, runtime, {
      entries,
      type
    })

    const promotionIds = result.map(({ promotionId }) => promotionId)

    if (promotionIds.length) {
      const counted = await grants.count({
        promotionId: {
          $in: promotionIds
        }
      })
      if (counted === 0) {
        return reply(boom.notFound('promotion not available'))
      }
    }

    return reply({
      grants: result
    })
  }
}

function uploadV4Grants (uploadSchema, contentSchema) {
  return (runtime) => async (request, reply) => {
    const batchId = uuid.v4().toLowerCase()
    const debug = braveHapi.debug(module, request)
    const grants = runtime.database.get('grants', debug)
    const promotions = runtime.database.get('promotions', debug)

    let payload = request.payload
    payload = payload.file || payload
    const {
      error,
      value
    } = Joi.validate(payload, uploadSchema)
    if (error) {
      return reply(boom.badData(error))
    }
    payload = value

    const grantsToInsert = []
    const promotionCounts = {}
    const status = 'active'
    let promoType = 'ugp'
    for (let token of payload.grants) {
      const grantContent = braveUtils.extractJws(token)
      const {
        error,
        value
      } = Joi.validate(grantContent, contentSchema)
      if (error) {
        return reply(boom.badData(error))
      }
      const {
        type,
        grantId,
        promotionId,
        providerId
      } = value
      const inserting = {
        type,
        grantId,
        batchId,
        token,
        promotionId,
        status
      }
      if (type === 'ads') {
        inserting.providerId = providerId
      }
      promoType = type
      grantsToInsert.push(inserting)
      if (!promotionCounts[promotionId]) {
        promotionCounts[promotionId] = 0
      }
      promotionCounts[promotionId]++
    }

    await grants.insert(grantsToInsert)

    for (let entry of payload.promotions) {
      let $set = underscore.assign({
        type: promoType,
        protocolVersion: 1
      }, underscore.omit(entry, ['promotionId']))
      let { promotionId } = entry
      const state = {
        $set,
        $currentDate: { timestamp: { $type: 'timestamp' } },
        $inc: { count: promotionCounts[promotionId] }
      }
      await promotions.update({
        promotionId
      }, state, { upsert: true })
    }

    reply({})
  }
}
