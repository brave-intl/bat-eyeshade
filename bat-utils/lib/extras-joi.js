const base58check = require('bs58check')
const batPublisher = require('bat-publisher')
const bitcoin = require('bitcoinjs-lib')
const countryCodes = require('country-list')()
const currencyCodes = require('currency-codes')
const Joi = require('joi')
const ethereumAddress = require('ethereum-address')

module.exports = Joi.extend({
  base: Joi.string(),
  name: 'string',
  language: {
    badAltcurrencyCode: 'invalid alternate currency code',
    badAnycurrencyCode: 'invalid alternate/fiat currency code',
    badBase58: 'bad Base58 encoding',
    badCountryCode: 'invalid country code',
    badCurrencyCode: 'invalid currency code',
    badEthAddress: 'invalid Ethereum address',
    badFormat: 'invalid format'
  },
  rules: [
    { name: 'altcurrencyAddress',

      params: { altcurrency: Joi.string().regex(/^[0-9A-Z]{2,}$/) },

      validate (params, value, state, options) {
        if (params.altcurrency === 'BTC' || params.altcurrency === 'LTC') {
          try { base58check.decode(value) } catch (err) {
            return this.createError('string.badBase58', { v: value }, state, options)
          }
        } else if (!ethereumAddress.isAddress(value)) return this.createError('string.badEthAddress', { v: value }, state, options)

        return value
      }
    },

    { name: 'altcurrencyCode',

      validate (params, value, state, options) {
        const regexp = new RegExp(/^[0-9A-Z]{2,}$/)

        if (!regexp.test(value)) return this.createError('string.badAltcurrencyCode', { v: value }, state, options)

        return value
      }
    },

    { name: 'anycurrencyCode',

      validate (params, value, state, options) {
        const entry = currencyCodes.code(value)
        const regexp = new RegExp(/^[0-9A-Z]{2,}$/)

        if ((!entry) && (!regexp.test(value))) {
          return this.createError('string.badAnycurrencyCode', { v: value }, state, options)
        }

        return value
      }
    },

    { name: 'base58',

      validate (params, value, state, options) {
        try { base58check.decode(value) } catch (err) {
          return this.createError('string.badBase58', { v: value }, state, options)
        }

        return value
      }
    },

    { name: 'countryCode',

      validate (params, value, state, options) {
        const entry = countryCodes.getName(value)

        if (!entry) return this.createError('string.badCountryCode', { v: value }, state, options)

        return value
      }
    },

    { name: 'currencyCode',

      validate (params, value, state, options) {
        const entry = currencyCodes.code(value)

        if (!entry) return this.createError('string.badCurrencyCode', { v: value }, state, options)

        return value
      }
    },

    { name: 'numeric',

      validate (params, value, state, options) {
        const isNumeric = new RegExp(/^-?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i)

        if (!isNumeric.test(value)) return this.createError('string.badFormat', { v: value }, state, options)

        return value
      }
    },

    { name: 'owner',

      validate (params, value, state, options) {
        const props = batPublisher.getPublisherProps(value)
        if ((!props) || (!props.publisherType)) return this.createError('string.badFormat', { v: value }, state, options)

        return value
      }
    },

    { name: 'publisher',

      validate (params, value, state, options) {
        if (!batPublisher.isPublisher(value)) return this.createError('string.badFormat', { v: value }, state, options)

        return value
      }
    },

    { name: 'Xpub',

      // courtesy of the good folks at BitGo!
      validate (params, value, state, options) {
        if (value.substr(0, 4) !== 'xpub') return this.createError('string.badFormat', { v: value }, state, options)

        try { bitcoin.HDNode.fromBase58(value) } catch (err) {
          return this.createError('string.badBase58', { v: value }, state, options)
        }

        return value
      }
    }
  ]
})
