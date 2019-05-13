import Joi from 'joi'
import netmask from 'netmask'
import l10nparser from 'accept-language-parser'
import boom from 'boom'
import bson from 'bson'
import underscore from 'underscore'
import uuidV4 from 'uuid/v4'
import wreck from 'wreck'
import utils from 'bat-utils'
import grantsLib from '../lib/grants'

const { Netmask } = netmask
const braveJoi = utils.extras.joi
const braveHapi = utils.extras.hapi
const braveUtils = utils.extras.utils
const whitelist = utils.hapi.auth.whitelist

const { NODE_ENV } = process.env
const isProduction = NODE_ENV === 'production'
const rateLimitEnabled = isProduction

const qalist = {
  authorizedAddrs: [],
  authorizedBlocks: [],
  addresses: process.env.IP_QA_WHITELIST && process.env.IP_QA_WHITELIST.split(',')
}

const claimRate = {
  limit: process.env.GRANT_CLAIM_RATE ? Number(process.env.GRANT_CLAIM_RATE) : 50,
  window: process.env.GRANT_CLAIM_WINDOW ? Number(process.env.GRANT_CLAIM_WINDOW) : 3 * 60 * 60
}

const captchaRate = {
  limit: process.env.GRANT_CLAIM_RATE ? Number(process.env.GRANT_CLAIM_RATE) : 50,
  window: process.env.GRANT_CLAIM_WINDOW ? Number(process.env.GRANT_CLAIM_WINDOW) : 3 * 60 * 60
}

if (qalist.addresses) {
  qalist.addresses.forEach((entry) => {
    if ((entry.indexOf('/') === -1) && (entry.split('.').length === 4)) return qalist.authorizedAddrs.push(entry)

    qalist.authorizedBlocks.push(new Netmask(entry))
  })
}

const qaOnlyP = (request) => {
  const ipaddr = whitelist.ipaddr(request)

  return (qalist.authorizedAddrs.length) && (qalist.authorizedAddrs.indexOf(ipaddr) === -1) &&
    (!underscore.find(qalist.authorizedBlocks, (block) => { return block.contains(ipaddr) }))
}

const rateLimitPlugin = {
  enabled: rateLimitEnabled && !qalist.addresses,
  rate: (request) => captchaRate
}

const priorityValidator = Joi.number().integer().min(0).description('the promotion priority (lower is better)')
const activeValidator = Joi.boolean().optional().default(true).description('the promotion status')
const protocolVersionValidator = Joi.number().integer().min(2).description('the protocol version that the promotion will follow')
const grantTypeValidator = Joi.string().allow(['ugp', 'ads']).default('ugp').description('the type of grant to use')
const paymentIdValidator = Joi.string().guid().description('identity of the wallet')
const promotionIdValidator = Joi.string().guid().description('the promotion-identifier')
const altcurrencyValidator = braveJoi.string().altcurrencyCode().description('the grant altcurrency')
const probiValidator = braveJoi.string().numeric().description('the grant amount in probi')
const minimumReconcileTimestampValidator = Joi.number().description('time when the promotion can be reconciled')
const encodedGrantValidator = Joi.string().description('the jws encoded grant')
const grantsValidator = Joi.array().min(0).items(encodedGrantValidator).description('grants for bulk upload')
const expiryTimeValidator = Joi.number().positive().description('the time the grant expires')
const grantProviderIdValidator = Joi.string().guid().when('type', {
  is: 'ads',
  then: Joi.required(),
  otherwise: Joi.forbidden()
})
const braveProductEnumValidator = Joi.string().valid(['browser-laptop', 'brave-core']).description('the brave product requesting the captcha')
const captchaResponseValidator = Joi.object().keys({
  x: Joi.number().required(),
  y: Joi.number().required()
})
const grantContentValidator = Joi.object().keys({
  grantId: Joi.string().guid().required().description('the grant-identifier'),
  promotionId: promotionIdValidator.required(),
  altcurrency: altcurrencyValidator.required(),
  probi: probiValidator.required(),
  maturityTime: Joi.number().positive().required().description('the time the grant becomes redeemable'),
  expiryTime: expiryTimeValidator.required()
})
const grantContentTypedValidator = grantContentValidator.keys({
  type: grantTypeValidator,
  providerId: grantProviderIdValidator
})
const publicGrantValidator = Joi.object().keys({
  altcurrency: altcurrencyValidator.optional().default('BAT'),
  expiryTime: expiryTimeValidator.optional(),
  probi: probiValidator.optional()
}).unknown(true).description('grant properties')
const publicGrantTypedValidator = publicGrantValidator.keys({
  type: grantTypeValidator,
  providerId: grantProviderIdValidator
})
const promotionValidator = Joi.object().keys({
  promotionId: promotionIdValidator.required(),
  priority: priorityValidator.required(),
  active: activeValidator
}).unknown(true).description('promotions for bulk upload')
const promotionsValidator = Joi.array().min(0).items(promotionValidator)
const grantsUploadValidator = Joi.object().keys({
  grants: grantsValidator,
  promotions: promotionsValidator
}).required().description('data for bulk upload')
const typedPromotionValidator = promotionValidator.keys({
  protocolVersion: protocolVersionValidator.required(),
  minimumReconcileTimestamp: minimumReconcileTimestampValidator.optional()
})
const promotionsTypedValidator = Joi.array().min(0).items(typedPromotionValidator)
const grantsUploadTypedValidator = grantsUploadValidator.keys({
  grants: grantsValidator,
  promotions: promotionsTypedValidator
})
const captchaHeadersValidator = Joi.object().keys({
  'brave-product': braveProductEnumValidator.optional().default('browser-laptop')
}).unknown(true).description('headers')

/*
   GET /v2/promotions
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

const v2All = {
  handler: getPromotions(2),
  description: 'See if a v2 promotion is available',
  tags: [ 'api' ],

  validate: { query: {} },

  response: {
    schema: promotionsGetResponseSchema
  }
}

const v3All = {
  handler: getPromotions(3),
  description: 'See if a v3 promotion is available',
  tags: [ 'api' ],

  validate: {},

  response: {
    schema: promotionsGetResponseSchema
  }
}

const v4All = {
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
   GET /v5/grants
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
    const {
      lang,
      paymentId,
      bypassCooldown
    } = request.query

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
    let entries, promotionIds, wallet
    let walletTooYoung = false

    if (qaOnlyP(request)) return reply(boom.notFound())

    if (paymentId) {
      promotionIds = []
      wallet = await wallets.findOne({ paymentId })
      if (!wallet) return reply(boom.notFound('no such wallet: ' + paymentId))
      if (wallet.grants) {
        promotionIds = wallet.grants.map(({ promotionId }) => promotionId)
      }
      underscore.extend(query, { promotionId: { $nin: promotionIds } })
      walletTooYoung = walletCooldown(wallet, bypassCooldown)
    }

    if (protocolVersion === 4 && !paymentId) {
      underscore.extend(query, { type: 'ugp' })
    }

    entries = await promotions.find(query)
    if ((!entries) || (!entries[0])) return reply(boom.notFound('no promotions available'))

    if (protocolVersion < 4) {
      entries = [entries[0]]
    }

    const filteredPromotions = []
    for (let { promotionId, type } of entries) {
      const query = { promotionId }
      if (type === 'ads') {
        if (!wallet) {
          continue
        }
        underscore.extend(query, { providerId: wallet.addresses.CARD_ID })
      }
      const counted = await grants.count(query)
      if (counted !== 0 && !walletTooYoung) {
        filteredPromotions.push({ promotionId, type })
      }
    }

    if (filteredPromotions.length === 0) {
      return reply(boom.notFound('promotion not available'))
    }

    if (protocolVersion < 4) {
      return reply(filteredPromotions[0])
    }

    reply({ grants: filteredPromotions })

    debug('grants', { languages: languages })
  }
}

const v2Read = {
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


const v3Read = {
  handler: safetynetPassthrough((runtime) => (request, reply) => {
    reply(boom.notFound('promotion not available'))
  }),
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

const v5Read = {
  handler: safetynetPassthrough(getGrant(3)),
  description: 'See if a v5 promotion is available',
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

const v4Read = {
  handler: getGrant(4),
  description: 'See if a v4 promotion is available',
  tags: [ 'api' ],

  validate: {
    query: {
      bypassCooldown: Joi.string().guid().optional().description('a token to bypass the wallet cooldown time'),
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

const v2ClaimGrant = {
  handler: claimGrant({
    $in: [2, 4]
  }, captchaCheck, v4CreateGrantQuery),
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

const v3ClaimGrant = {
  handler: claimGrant(3, safetynetCheck),
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
    schema: publicGrantTypedValidator
  }
}

/*
   PUT /v4/grants/{paymentId}
 */

const v4ClaimGrant = {
  handler: claimGrant(4, captchaCheck, v4CreateGrantQuery),
  description: 'Request a grant for a wallet',
  tags: [ 'api' ],

  plugins: {
    rateLimit: rateLimitPlugin
  },

  validate: {
    params: Joi.object().keys({
      paymentId: paymentIdValidator.required()
    }),
    payload: Joi.object().keys({
      promotionId: promotionIdValidator.required(),
      captchaResponse: captchaResponseValidator.optional()
    }).required().description('promotion details')
  },

  response: {
    schema: publicGrantTypedValidator
  }
}

function claimGrant (protocolVersion, validate, createGrantQuery = defaultCreateGrantQuery) {
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

    const promotion = await promotions.findOne({
      promotionId,
      protocolVersion
    })
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

  let validNonce = wallet.nonce === data.nonce
  const updates = <any>{
    $unset: { nonce: {} }
  }
  if (validNonce) {
    updates.$set = {
      cohort: 'safetynet'
    }
  }

  await wallets.findOneAndUpdate({
    paymentId
  }, updates)

  if (!validNonce) {
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

/*
   POST /v2/grants
*/

const uploadGrants = (protocolVersion) => (runtime) => {
  return async (request, reply) => {
    const batchId = uuidV4().toLowerCase()
    const debug = braveHapi.debug(module, request)
    const grants = runtime.database.get('grants', debug)
    const promotions = runtime.database.get('promotions', debug)
    let state

    let payload = request.payload

    if (payload.file) {
      payload = payload.file
      const validity = Joi.validate(payload, grantsUploadValidator)
      if (validity.error) {
        return reply(boom.badData(validity.error))
      }
    }

    const grantsToInsert = []
    const promotionCounts = {}
    for (let entry of payload.grants) {
      const grantContent = braveUtils.extractJws(entry)
      const validity = Joi.validate(grantContent, grantContentValidator)
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

const v2Create =
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
  POST /v4/grants
*/

const v4Create =
{ handler: uploadTypedGrants(4, grantsUploadTypedValidator, grantContentTypedValidator),

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

const v2Cohorts = { handler: (runtime) => {
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
    const type = request.headers['promotion-type'] || 'ugp'
    const paymentId = request.params.paymentId.toLowerCase()
    const debug = braveHapi.debug(module, request)
    const wallets = runtime.database.get('wallets', debug)

    if (!runtime.config.captcha) return reply(boom.notFound())
    if (qaOnlyP(request)) return reply(boom.notFound())

    const wallet = await wallets.findOne({ 'paymentId': paymentId })
    if (!wallet) return reply(boom.notFound('no such wallet: ' + paymentId))

    const braveProduct = request.headers['brave-product'] || 'browser-laptop'
    if (protocolVersion === 2 && braveProduct !== 'brave-core') {
      return reply(boom.notFound('no captcha endpoints'))
    }

    const captchaEndpoints = {
      2: '/v2/captchas/variableshapetarget',
      4: '/v2/captchas/variableshapetarget'
    }

    const endpoint = captchaEndpoints[protocolVersion]
    if (!endpoint) {
      return reply(boom.notFound('no protocol version'))
    }

    const { res, payload } = await wreck.get(runtime.config.captcha.url + endpoint, {
      headers: {
        'Promotion-Type': type,
        'Authorization': 'Bearer ' + runtime.config.captcha.access_token,
        'Content-Type': 'application/json',
        'X-Forwarded-For': whitelist.ipaddr(request)
      }
    })

    const { headers } = res

    const solution = JSON.parse(headers['captcha-solution'])
    const captcha = underscore.extend(solution, {
      version: protocolVersion
    })
    await wallets.findOneAndUpdate({ 'paymentId': paymentId }, { $set: { captcha } })

    return reply(payload).header('Content-Type', headers['content-type']).header('Captcha-Hint', headers['captcha-hint'])
  }
}

const v2GetCaptcha = {
  handler: getCaptcha(2),
  description: 'Get a claim time captcha',
  tags: [ 'api' ],

  plugins: {
    rateLimit: rateLimitPlugin
  },

  validate: {
    params: {
      paymentId: paymentIdValidator.required()
    },
    headers: captchaHeadersValidator
  }
}

const v4GetCaptcha = {
  handler: getCaptcha(4),
  description: 'Get a claim time v4 captcha',
  tags: [ 'api' ],

  plugins: {
    rateLimit: rateLimitPlugin
  },

  validate: {
    params: {
      paymentId: paymentIdValidator.required()
    },
    headers: captchaHeadersValidator
  }
}

/*
  GET /v1/attestations/{paymentId}
*/

const v3Attestations = {
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

    const nonce = uuidV4()

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

const v2 = {
  all: v2All,
  read: v2Read,
  claimGrant: v2ClaimGrant,
  create: v2Create,
  cohorts: v2Cohorts,
  getCaptcha: v2GetCaptcha
}
const v3 = {
  all: v3All,
  read: v3Read,
  claimGrant: v3ClaimGrant,
  attestations: v3Attestations
}
const v4 = {
  read: v4Read,
  claimGrant: v4ClaimGrant,
  create: v4Create,
  getCaptcha: v4GetCaptcha
}
const v5 = {
  read: v5Read
}

const routes = [
  braveHapi.routes.async().path('/v2/promotions').config(v2.all),
  braveHapi.routes.async().path('/v3/promotions').config(v3.all),
  braveHapi.routes.async().path('/v2/grants').config(v2.read),
  braveHapi.routes.async().path('/v3/grants').config(v3.read),
  braveHapi.routes.async().path('/v4/grants').config(v4.read),
  braveHapi.routes.async().path('/v5/grants').config(v5.read),
  braveHapi.routes.async().put().path('/v2/grants/{paymentId}').config(v2.claimGrant),
  braveHapi.routes.async().put().path('/v3/grants/{paymentId}').config(v3.claimGrant),
  braveHapi.routes.async().put().path('/v4/grants/{paymentId}').config(v4.claimGrant),
  braveHapi.routes.async().post().path('/v2/grants').config(v2.create),
  braveHapi.routes.async().post().path('/v4/grants').config(v4.create),
  braveHapi.routes.async().path('/v1/attestations/{paymentId}').config(v3.attestations),
  braveHapi.routes.async().put().path('/v2/grants/cohorts').config(v2.cohorts),
  braveHapi.routes.async().path('/v2/captchas/{paymentId}').config(v2.getCaptcha),
  braveHapi.routes.async().path('/v4/captchas/{paymentId}').config(v4.getCaptcha)
]

const initialize = async (debug, runtime) => {
  await runtime.database.checkIndices(debug, [
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
}, nil) {
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
    type,
    status: 'active',
    promotionId,
    providerId: <any>undefined
  }
  if (type === 'ads') {
    query.providerId = addresses.CARD_ID
  }
  return query
}

function uploadTypedGrants (protocolVersion, uploadSchema, contentSchema) {
  return (runtime) => async (request, reply) => {
    const batchId = uuidV4().toLowerCase()
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
        status,
        providerId: <any>undefined
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
        protocolVersion
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

function walletCooldown (wallet, bypassCooldown) {
  const { _id } = wallet
  const { WALLET_COOLDOWN_BYPASS_TOKEN } = process.env
  if (isProduction || bypassCooldown !== WALLET_COOLDOWN_BYPASS_TOKEN) {
    const offset = grantsLib.cooldownOffset()
    const createdTime = braveUtils.createdTimestamp(_id)
    return createdTime > (+(new Date()) - offset)
  }
  return false
}

export default {
  routes,
  initialize
}
