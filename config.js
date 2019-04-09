/* jshint asi: true, node: true, laxbreak: true, laxcomma: true, undef: true, unused: true, esversion: 6 */

const services = {
  ledger: {
    portno: 3001,

    f: () => {
      if (process.env.COINBASE_WIDGET_CODE) {
        module.exports.wallet.coinbase = { widgetCode : process.env.COINBASE_WIDGET_CODE }
      }

      if (process.env.REDEEMER_URL) {
        module.exports.redeemer =
        { url               : process.env.REDEEMER_URL   || 'http://127.0.0.1:3333'
        , access_token      : process.env.REDEEMER_TOKEN || '00000000-0000-4000-0000-000000000000'
        }
      }
      if (process.env.REDEEMER_CARD_ID) {
        module.exports.redeemer =
        { cardId               : process.env.REDEEMER_CARD_ID
        }
      }
      if (process.env.BALANCE_URL) {
        module.exports.balance =
          { url                 : process.env.BALANCE_URL    || 'http://127.0.0.1:3000'
          , access_token        : process.env.BALANCE_TOKEN  || '00000000-0000-4000-0000-000000000000'
          }
      }
      if (process.env.CAPTCHA_URL) {
        module.exports.captcha =
        { url               : process.env.CAPTCHA_URL   || 'http://127.0.0.1:3334'
        , access_token      : process.env.CAPTCHA_TOKEN || '00000000-0000-4000-0000-000000000000'
        , bypass            : process.env.CAPTCHA_BYPASS_TOKEN || '00000000-0000-4000-0000-000000000000'
        }
      }
      publishers()
      uphold()
    }
  },

  eyeshade: {
    portno: 3002,

    f: () => {
      module.exports.referrals =
        { currency              : process.env.REFERRALS_CURRENCY || 'USD'
        , amount                : process.env.REFERRALS_AMOUNT || 5
        }
      module.exports.postgres =
        { url                   : process.env.DATABASE_URL || 'postgres://localhost/test'
        , schemaVersionCheck    : true
        }

      publishers()
      uphold()
    }
  },

  balance: {
    portno: 3003,

    f: () => {
      module.exports.ledger = {
        url : process.env.LEDGER_URL  || 'http://127.0.0.1:3001'
      }

      uphold()
    }
  }
}

const publishers = () => {
  module.exports.publishers = {}
  if (process.env.PUBLISHERS_URL) {
    const takeover = process.env.PUBLISHERS_TAKEOVER
    module.exports.publishers =
      { url                 : process.env.PUBLISHERS_URL    || 'http://127.0.0.1:3000'
      , access_token        : process.env.PUBLISHERS_TOKEN  || '00000000-0000-4000-0000-000000000000'
      , takeover            : takeover ? ({ true: true, false: false })[takeover] : false
      }
  }
}

const uphold = () => {
  if ((!process.env.UPHOLD_ACCESS_TOKEN) && (!process.env.UPHOLD_CLIENT_ID)) return

  module.exports.wallet.uphold =
  { accessToken       : process.env.UPHOLD_ACCESS_TOKEN         || 'none'
  , clientId          : process.env.UPHOLD_CLIENT_ID            || 'none'
  , clientSecret      : process.env.UPHOLD_CLIENT_SECRET        || 'none'
  , environment       : process.env.UPHOLD_ENVIRONMENT          || 'sandbox'
  }
}

const service = services[process.env.SERVICE]
if (!service) {
  throw new Error('invalid process.env.SERVICE=' + process.env.SERVICE)
}

process.env.PORT = process.env.PORT  || service.portno

const SERVICE = process.env.SERVICE.toUpperCase()
new Array('MONGODB_URI', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'SLACK_CHANNEL', 'SLACK_ICON_URL').forEach((v) => {
  process.env[v] = process.env[v]  || process.env[SERVICE + '_' + v]
})

module.exports =
{ altcurrency           : process.env.ALTCURRENCY               || 'BAT'
, cache                 :
  { redis               :
    { url               : process.env.REDIS_URL                 || 'redis://localhost:6379' }
  }
, currency              :
  { altcoins            : process.env.CRYPTO_CURRENCIES ? process.env.CRYPTO_CURRENCIES.split(',')
                                                        : [ 'BAT', 'BTC', 'ETH', 'LTC' ] }
, database              :
  { mongo               : process.env.MONGODB_URI               || 'localhost/test' }
, login                 : { github: false }
, queue                 :
  { rsmq                : process.env.REDIS_URL                 || 'redis://localhost:6379' }
, sentry                :
  { dsn: process.env.SENTRY_DSN          || false
  , slug: process.env.HEROKU_SLUG_COMMIT || 'test'
  , project: process.env.HEROKU_APP_NAME  || process.env.SERVICE
  }
, newrelic              : { key: process.env.NEW_RELIC_LICENSE_KEY
                                                                || false }
, wallet                : { }

, testingCohorts        : process.env.TESTING_COHORTS ? process.env.TESTING_COHORTS.split(',') : []
, currency:
  { url: process.env.BAT_RATIOS_URL
  , access_token: process.env.BAT_RATIOS_TOKEN
  }
}
if (service.f) service.f()

if (process.env.NODE_ENV === 'production') {
  module.exports.server = require('url').parse('https://' + process.env.HOST)
} else {
  module.exports.server = require('url').parse('http://' + '127.0.0.1' + ':' + process.env.PORT)
}

if (process.env.BAT_SETTLEMENT_ADDRESS) {
  module.exports.wallet.settlementAddress =
  { BAT : process.env.BAT_SETTLEMENT_ADDRESS                || '0x7c31560552170ce96c4a7b018e93cddc19dc61b6' }
}

if (process.env.BAT_ADS_PAYOUT_ADDRESS) {
  module.exports.wallet.adsPayoutAddress =
  { BAT : process.env.BAT_ADS_PAYOUT_ADDRESS                || '0x7c31560552170ce96c4a7b018e93cddc19dc61b6' }
}

if (process.env.SLACK_WEBHOOK) {
  module.exports.slack =
  { webhook             : process.env.SLACK_WEBHOOK
  , channel             : process.env.SLACK_CHANNEL             || '#bat-bot'
  , icon_url            : process.env.SLACK_ICON_URL            || 'https://github.com/brave-intl/bat-ledger/raw/master/documentation/favicon.png'
  }
}

if (process.env.GITHUB_ORG) {
  module.exports.login.github =
  { organization        : process.env.GITHUB_ORG
  , world               : process.env.GITHUB_LOGIN_WORLD        || '/documentation'
  , bye                 : process.env.GITHUB_LOGIN_BYE          || 'https://example.com'
  , clientId            : process.env.GITHUB_CLIENT_ID
  , clientSecret        : process.env.GITHUB_CLIENT_SECRET
  , ironKey             : process.env.IRON_KEYPASS              || 'cookie-encryption-password-at-least-32-octets'
  , isSecure            : process.env.GITHUB_FORCE_HTTPS        || false
  }
}

if (process.env.DYNO) {
  module.exports.prometheus =
    { label              : process.env.SERVICE + '.' + process.env.DYNO
    , redis              : process.env.REDIS2_URL               || process.env.REDIS_URL               ||  false
    }
}
