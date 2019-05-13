import crypto from 'crypto'
import BigNumber from 'bignumber.js'
import SDebug from 'sdebug'
import * as UpholdSDK from '@uphold/uphold-sdk-javascript'
import underscore from 'underscore'
import httpRequestSignature from 'http-request-signature'
import Joi from 'joi'

import braveHapi from './extras-hapi'
import braveJoi from './extras-joi'
import braveUtils from './extras-utils'
import whitelist from './hapi-auth-whitelist'

import Currency from './runtime-currency'

const { verify } = httpRequestSignature
const debug = new SDebug('wallet')
const upholdBaseUrls = {
  prod: 'https://api.uphold.com',
  sandbox: 'https://api-sandbox.uphold.com'
}

const cardInfoSchema = Joi.object().keys({
  balance: braveJoi.string().numeric().required(),
  available: braveJoi.string().numeric().required()
}).unknown(true).description('a pared down version of card info from uphold')

const Wallet = function (config, runtime): void {
  if (!(this instanceof Wallet)) return new Wallet(config, runtime)

  if (!config.wallet) return

  this.config = config.wallet
  this.runtime = runtime
  if (config.wallet.uphold) {
    if ((process.env.FIXIE_URL) && (!process.env.HTTPS_PROXY)) process.env.HTTPS_PROXY = process.env.FIXIE_URL
    this.uphold = this.createUpholdSDK(this.config.uphold.accessToken)
  }

  if (config.currency) {
    this.currency = new Currency(config, runtime)
  }
}

Wallet.prototype.createCard = async function () {
  let f = mockProvider.createCard
  if (this.config.uphold) {
    f = upholdProvider.createCard
  }
  if (!f) return {}
  return f.apply(this, arguments)
}

Wallet.prototype.create = async function (requestType, request) {
  let f = mockProvider.create
  if (this.config.uphold) {
    f = upholdProvider.create
  }
  if (!f) return {}
  return f.bind(this)(requestType, request)
}

Wallet.prototype.balances = async function (info) {
  const f = Wallet.providers[info.provider].balances

  if (!f) throw new Error('provider ' + info.provider + ' balances not supported')
  return f.bind(this)(info)
}

Wallet.prototype.transfer = async function (info, satoshis) {
  const f = Wallet.providers[info.provider].transfer

  if (!f) throw new Error('provider ' + info.provider + ' transfer not supported')
  return f.bind(this)(info, satoshis)
}

Wallet.prototype.getTxProbi = function (info, txn) {
  if (info.altcurrency === 'BAT' && (info.provider === 'uphold' || info.provider === 'mockHttpSignature')) {
    return new BigNumber(txn.denomination.amount).times(this.currency.alt2scale(info.altcurrency))
  } else {
    throw new Error('getTxProbi not supported for ' + info.altcurrency + ' at ' + info.provider)
  }
}

Wallet.prototype.validateTxSignature = function (info, signature, options = {}) {
  const {
    minimum = 1
  } = options
  const bigMinimum = new BigNumber(minimum)
  if (bigMinimum.lessThanOrEqualTo(0)) {
    throw new Error('minimum must be greater than 0')
  }

  const upholdTxnSchema = Joi.object().keys({
    denomination: Joi.object().keys({
      amount: braveJoi.string().numeric().required(),
      currency: Joi.string().valid('BAT').required()
    }),
    destination: Joi.string().valid(this.config.settlementAddress['BAT']).required()
  })

  if (info.altcurrency === 'BAT' && (info.provider === 'uphold' || info.provider === 'mockHttpSignature')) {
    if (!signature.headers.digest) throw new Error('a valid http signature must include the content digest')

    const txn = JSON.parse(signature.octets)
    if (JSON.stringify(txn) !== signature.octets) {
      throw new Error('octets are not canonical')
    }

    const tmp = Joi.validate(txn, upholdTxnSchema).error
    if (tmp !== null) throw new Error('the signed transaction failed to validate')

    const { amount } = txn.denomination
    if (bigMinimum.greaterThan(amount)) {
      const error = new Error('amount is less than minimum')
      this.runtime.captureException(error, {
        extra: {
          amount,
          minimum
        }
      })
      throw error
    }

    const expectedDigest = 'SHA-256=' + crypto.createHash('sha256').update(signature.octets, 'utf8').digest('base64')
    if (expectedDigest !== signature.headers.digest) throw new Error('the digest specified is not valid for the unsigned transaction provided')

    const result = verify({headers: signature.headers, publicKey: info.httpSigningPubKey}, { algorithm: 'ed25519' })
    if (!result.verified) throw new Error('the http-signature is not valid')
  } else {
    throw new Error('wallet validateTxSignature for requestType ' + info.requestType + ' not supported for altcurrency ' + info.altcurrency)
  }
}

Wallet.prototype.unsignedTx = async function (info, amount, currency, balance) {
  const f = Wallet.providers[info.provider].unsignedTx

  if (!f) throw new Error('provider ' + info.provider + ' unsignedTx not supported')
  return f.bind(this)(info, amount, currency, balance)
}

Wallet.prototype.submitTx = async function (info, txn, signature) {
  const f = Wallet.providers[info.provider].submitTx

  if (!f) throw new Error('provider ' + info.provider + ' submitTx not supported')
  return f.bind(this)(info, txn, signature)
}

Wallet.prototype.ping = async function (provider) {
  const f = Wallet.providers[provider].ping

  if (!f) throw new Error('provider ' + provider + ' ping not supported')
  return f.bind(this)(provider)
}

Wallet.prototype.status = async function (info) {
  const f = Wallet.providers[info.provider].status

  if (!f) throw new Error('provider ' + info.provider + ' status not supported')
  return f.bind(this)(info)
}

Wallet.prototype.providers = function () {
  return underscore.keys(Wallet.providers)
}

Wallet.prototype.isGrantExpired = function (info, grant) {
  const { token } = grant

  const jws = braveUtils.extractJws(token)
  const { expiryTime } = jws

  return Date.now() > (expiryTime * 1000)
}

Wallet.prototype.expireGrant = async function (info, wallet, grant) {
  const { runtime } = this
  const { database } = runtime
  const { paymentId } = wallet
  const { grantId } = grant

  const wallets = database.get('wallets', debug)

  const $set = {
    'grants.$.status': 'expired'
  }
  const state = { $set }
  const where = {
    paymentId,
    'grants.grantId': grantId
  }
  await wallets.update(where, state)
}

Wallet.selectGrants = selectGrants

Wallet.prototype.redeem = async function (info, txn, signature, request) {
  let balance, desired, grants, grantIds, payload, result

  if (!this.runtime.config.redeemer) return

  grants = info.grants
  if (!grants) return
  grants = selectGrants(grants)
  if (grants.length === 0) return

  if (!info.balances) info.balances = await this.balances(info)
  balance = new BigNumber(info.balances.confirmed)
  desired = new BigNumber(txn.denomination.amount).times(this.currency.alt2scale(info.altcurrency))

  const infoKeys = [
    'altcurrency', 'provider', 'providerId', 'paymentId'
  ]
  const wallet = underscore.extend(underscore.pick(info, infoKeys), { publicKey: info.httpSigningPubKey })
  payload = {
    grants: [],
    // TODO might need paymentId later
    wallet,
    transaction: Buffer.from(JSON.stringify(underscore.pick(signature, [ 'headers', 'octets' ]))).toString('base64')
  }
  grantIds = []
  let grantTotal = new BigNumber(0)

  for (let grant of grants) {
    if (this.isGrantExpired(info, grant)) {
      await this.expireGrant(info, wallet, grant)
      continue
    }
    payload.grants.push(grant.token)
    grantIds.push(grant.grantId)

    const grantContent = braveUtils.extractJws(grant.token)
    const probi = new BigNumber(grantContent.probi)
    balance = balance.plus(probi)
    grantTotal = grantTotal.plus(probi)
    if (grantTotal.greaterThanOrEqualTo(desired)) break
  }

  if (balance.lessThan(desired)) return

  if (info.cohort && this.runtime.config.testingCohorts.includes(info.cohort)) {
    return {
      probi: desired.toString(),
      altcurrency: info.altcurrency,
      address: txn.destination,
      fee: 0,
      status: 'accepted',
      grantIds: grantIds,
      grantTotal: new BigNumber(0)
    }
  }

  result = await braveHapi.wreck.post(this.runtime.config.redeemer.url + '/v1/grants', {
    headers: {
      'Authorization': 'Bearer ' + this.runtime.config.redeemer.access_token,
      'Content-Type': 'application/json',
      // Only pass "trusted" IP, not previous value of X-Forwarded-For
      'X-Forwarded-For': whitelist.ipaddr(request),
      'User-Agent': request.headers['user-agent']
    },
    payload: JSON.stringify(payload),
    useProxyP: true
  })
  const resultJSON = debuffer(result)
  return underscore.extend(resultJSON, { grantIds: grantIds, grantTotal: grantTotal })
}

function debuffer (result) {
  if (Buffer.isBuffer(result)) {
    const str = result.toString()
    try {
      return JSON.parse(str)
    } catch (ex) {
      return str
    }
  }
  return result
}

Wallet.prototype.purchaseBAT = async function (info, amount, currency, language) {
  // TBD: if there is more than one provider, use a "real" algorithm to determine which one
  for (let provider in Wallet.providers) {
    const f = Wallet.providers[provider].purchaseBAT
    let result

    if (!f) continue

    try {
      result = await f.bind(this)(info, amount, currency, language)
      if (result) return result
    } catch (ex) {
      debug('error in ' + provider + '.purchaseBAT: ' + ex.toString())
      console.log(ex.stack)
    }
  }

  return {}
}

Wallet.prototype.createUpholdSDK = function (token) {
  const options = {
    baseUrl: upholdBaseUrls[this.config.uphold.environment],
    clientId: this.config.uphold.clientId,
    clientSecret: this.config.uphold.clientSecret
  }
  const uphold = new UpholdSDK.default(options) // eslint-disable-line new-cap
  uphold.storage.setItem(uphold.options.accessTokenKey, token)
  return uphold
}

const upholdProvider = {
  createCard: async function (info, {
    currency,
    label,
    options
  }) {
    const accessToken = info.parameters.access_token
    const uphold = this.createUpholdSDK(accessToken)
    return uphold.createCard(currency, label, Object.assign({
      authenticate: true
    }, options))
  },
  create: async function (requestType, request) {
    if (requestType === 'httpSignature') {
      const altcurrency = request.body.currency
      if (altcurrency === 'BAT') {
        let btcAddr, ethAddr, ltcAddr, wallet

        try {
          wallet = await this.uphold.api('/me/cards', { body: request.octets, method: 'post', headers: request.headers })
          ethAddr = await this.uphold.createCardAddress(wallet.id, 'ethereum')
          btcAddr = await this.uphold.createCardAddress(wallet.id, 'bitcoin')
          ltcAddr = await this.uphold.createCardAddress(wallet.id, 'litecoin')
        } catch (ex) {
          debug('create', {
            provider: 'uphold',
            reason: ex.toString(),
            operation: btcAddr ? 'litecoin' : ethAddr ? 'bitcoin' : wallet ? 'ethereum' : '/me/cards'
          })
          throw ex
        }
        return { 'wallet': { 'addresses': {
          'BAT': ethAddr.id,
          'BTC': btcAddr.id,
          'CARD_ID': wallet.id,
          'ETH': ethAddr.id,
          'LTC': ltcAddr.id
        },
          'provider': 'uphold',
          'providerId': wallet.id,
          'httpSigningPubKey': request.body.publicKey,
          'altcurrency': 'BAT' } }
      } else {
        throw new Error('wallet uphold create requestType ' + requestType + ' not supported for altcurrency ' + altcurrency)
      }
    } else {
      throw new Error('wallet uphold create requestType ' + requestType + ' not supported')
    }
  },
  balances: async function (info) {
    let cardInfo

    try {
      cardInfo = await this.uphold.getCard(info.providerId)
    } catch (ex) {
      debug('balances', { provider: 'uphold', reason: ex.toString(), operation: 'getCard' })
      throw ex
    }

    const altScale = this.currency.alt2scale(info.altcurrency)
    const { error } = Joi.validate(cardInfo, cardInfoSchema)
    if (error) {
      this.runtime.captureException(error, {
        extra: {
          providerId: info.providerId,
          card: cardInfo
        }
      })
      throw error
    }
    const balanceProbi = new BigNumber(cardInfo.balance).times(altScale)
    const spendableProbi = new BigNumber(cardInfo.available).times(altScale)
    return {
      balance: balanceProbi.toString(),
      spendable: spendableProbi.toString(),
      confirmed: spendableProbi.toString(),
      unconfirmed: balanceProbi.minus(spendableProbi).toString()
    }
  },
  unsignedTx: async function (info, amount, currency, balance) {
    if (info.altcurrency === 'BAT') {
      // TODO This logic should be abstracted out into the PUT wallet payment endpoint
      // such that this takes desired directly
      let desired = new BigNumber(amount.toString()).times(this.currency.alt2scale(info.altcurrency))

      currency = currency.toUpperCase()
      if (currency !== info.altcurrency) {
        const rate = await this.currency.ratio(currency, 'BAT')
        if (!rate) throw new Error('no conversion rate for ' + currency + ' to BAT')

        desired = desired.dividedBy(new BigNumber(rate.toString()))
      }
      const minimum = desired.times(0.90)

      debug('unsignedTx', { balance: balance, desired: desired, minimum: minimum })

      if (minimum.greaterThan(balance)) return

      desired = desired.floor()

      if (desired.greaterThan(balance)) desired = new BigNumber(balance)

      // NOTE skipping fee calculation here as transfers within uphold have none

      const deonominationAmount = desired.dividedBy(this.currency.alt2scale(info.altcurrency)).toString()

      return { 'requestType': 'httpSignature',
        'unsignedTx': { 'denomination': { amount: deonominationAmount, currency: 'BAT' },
          'destination': this.config.settlementAddress['BAT']
        }
      }
    } else {
      throw new Error('wallet uphold unsignedTx for ' + info.altcurrency + ' not supported')
    }
  },
  submitTx: async function (info, txn, signature) {
    if (info.altcurrency === 'BAT') {
      let postedTx

      try {
        postedTx = await this.uphold.createCardTransaction(info.providerId,
                                                           // this will be replaced below, we're just placating
                                                           underscore.pick(underscore.extend(txn.denomination,
                                                                                             { destination: txn.destination }),
                                                                           ['amount', 'currency', 'destination']),
                                                           true,        // commit tx in one swoop
                                                           null,        // no otp code
                                                           { headers: signature.headers, body: signature.octets })
      } catch (ex) {
        debug('submitTx', { provider: 'uphold', reason: ex.toString(), operation: 'createCardTransaction' })
        throw ex
      }

      if (postedTx.fees.length !== 0) { // fees should be 0 with an uphold held settlement address
        throw new Error(`unexpected fee(s) charged: ${JSON.stringify(postedTx.fees)}`)
      }

      return {
        probi: new BigNumber(postedTx.destination.amount).times(this.currency.alt2scale(info.altcurrency)).toString(),
        altcurrency: info.altcurrency,
        address: txn.destination,
        fee: 0,
        status: postedTx.status
      }
    } else {
      throw new Error('wallet uphold submitTx for ' + info.altcurrency + ' not supported')
    }
  },
  ping: async function (provider) {
    try {
      return { result: await this.uphold.api('/ticker/BATUSD') }
    } catch (ex) {
      return { err: ex.toString() }
    }
  },
  status: async function (info) {
    let result, uphold, user, desiredCard, desiredCardCurrency, possibleCurrencies, availableCurrencies

    desiredCardCurrency = info.defaultCurrency // Set by Publishers

    try {
      uphold = this.createUpholdSDK(info.parameters.access_token)
      debug('uphold api', uphold.api)
      user = await uphold.api('/me')
      if (user.status !== 'pending') {
        desiredCard = (await uphold.api('/me/cards?q=currency:' + desiredCardCurrency))[0]
      }
    } catch (ex) {
      debug('status', { provider: 'uphold', reason: ex.toString(), operation: '/me' })
      throw ex
    }

    availableCurrencies = underscore.keys(user.balances.currencies) || []  // TODO remove available currencies when https://github.com/brave-intl/publishers/issues/1725 is complete
    possibleCurrencies = user.currencies

    result = {
      id: user.id,
      provider: info.provider,
      authorized: user.status === 'ok',
      status: user.status,
      isMember: !!user.memberAt,
      defaultCurrency: desiredCardCurrency,
      availableCurrencies: availableCurrencies,
      possibleCurrencies: possibleCurrencies
    }
    if (result.authorized) {
      result.address = desiredCard && desiredCard.id
    }

    return result
  }
}

const mockProvider = {
  createCard: async (info, {
    currency,
    label,
    options
  }) => {},
  create: async function (requestType, request) {
    if (requestType === 'httpSignature') {
      const altcurrency = request.body.currency
      if (altcurrency === 'BAT') {
        // TODO generate random addresses?
        return { 'wallet': { 'addresses': {
          'BAT': this.config.settlementAddress['BAT']
        },
          'provider': 'mockHttpSignature',
          'httpSigningPubKey': request.body.publicKey,
          'altcurrency': 'BAT' } }
      } else {
        throw new Error('wallet mock create requestType ' + requestType + ' not supported for altcurrency ' + altcurrency)
      }
    } else {
      throw new Error('wallet mock create requestType ' + requestType + ' not supported')
    }
  },
  balances: async function (info) {
    if (info.altcurrency === 'BAT') {
      return {
        balance: '32061750000000000000',
        spendable: '32061750000000000000',
        confirmed: '32061750000000000000',
        unconfirmed: '0'
      }
    } else {
      throw new Error('wallet mock balances for ' + info.altcurrency + ' not supported')
    }
  },
  unsignedTx: async function (info, amount, currency, balance) {
    if (info.altcurrency === 'BAT' && info.provider === 'mockHttpSignature') {
      return { 'requestType': 'httpSignature',
        'unsignedTx': { 'denomination': { 'amount': '24.1235', currency: 'BAT' },
          'destination': this.config.settlementAddress['BAT']
        }
      }
    } else {
      throw new Error('wallet mock unsignedTx for ' + info.altcurrency + ' not supported')
    }
  },
  submitTx: async function (info, txn, signature) {
    if (info.altcurrency === 'BAT') {
      return {
        probi: new BigNumber(txn.denomination.amount).times(this.currency.alt2scale(info.altcurrency)).toString(),
        altcurrency: txn.denomination.currency,
        address: txn.destination,
        fee: '300',
        status: 'accepted'
      }
    }
  }
}

Wallet.providers = {
  uphold: upholdProvider,
  mock: mockProvider,
  mockHttpSignature: mockProvider
}

export default Wallet

function selectGrants (grants_ = []) {
  // we could try to optimize the determination of which grant to use, but there's probably going to be only one...
  const grants = grants_.filter((grant) => grant.status === 'active')

  // sorting munges grants
  grants.sort((a, b) => {
    let expiryTimestampA = extractExpiryTime(a)
    let expiryTimestampB = extractExpiryTime(b)
    return expiryTimestampA > expiryTimestampB ? 1 : -1
  })

  return grants

  function extractExpiryTime (grant) {
    return braveUtils.extractJws(grant.token).expiryTime
  }
}
