/* jshint asi: true, node: true, laxbreak: true, laxcomma: true, undef: true, unused: true, esversion: 6 */
const url = require('url')
const env = require('./env')
const {
  REFERRALS_CURRENCY,
  REFERRALS_AMOUNT,
  DATABASE_URL,
  DYNO,
  LEDGER_URL,
  GITHUB_LOGIN_WORLD,
  GITHUB_LOGIN_BYE,
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  IRON_KEYPASS,
  GITHUB_FORCE_HTTPS,
  BAT_SETTLEMENT_ADDRESS,
  BAT_ADS_PAYOUT_ADDRESS,
  COINBASE_WIDGET_CODE,
  REDEEMER_URL,
  BALANCE_URL,
  BALANCE_TOKEN,
  REDEEMER_TOKEN,
  REDEEMER_CARD_ID,
  SERVICE,
  CAPTCHA_URL,
  CAPTCHA_TOKEN,
  CAPTCHA_BYPASS_TOKEN,
  UPHOLD_ACCESS_TOKEN,
  UPHOLD_CLIENT_ID,
  UPHOLD_CLIENT_SECRET,
  UPHOLD_ENVIRONMENT,
  PUBLISHERS_TAKEOVER,
  PUBLISHERS_URL,
  PUBLISHERS_TOKEN,
  ALTCURRENCY,
  CRYPTO_CURRENCIES,
  REDIS_URL,
  REDIS2_URL,
  SENTRY_DSN,
  HEROKU_APP_NAME,
  HEROKU_SLUG_COMMIT,
  MONGODB_URI,
  TESTING_COHORTS,
  NEW_RELIC_LICENSE_KEY,
  SLACK_CHANNEL,
  SLACK_ICON_URL,
  BAT_RATIOS_URL,
  BAT_RATIOS_TOKEN,
  SLACK_WEBHOOK,
  NODE_ENV,
  GITHUB_ORG,
  HOST,
  PORT
} = env

module.exports = generate(SERVICE)

function generate (SERVICE) {
  const booleanHash = {
    true: true,
    false: false
  }
  const altcurrency = ALTCURRENCY || 'BAT'
  const cache = {
    redis: {
      url: REDIS_URL || 'redis://localhost:6379'
    }
  }
  const database = {
    mongo: MONGODB_URI || 'localhost/test'
  }
  const login = {
    github: false
  }
  const queue = {
    rsmq: REDIS_URL || 'redis://localhost:6379'
  }
  const sentry = {
    dsn: SENTRY_DSN || false,
    slug: HEROKU_SLUG_COMMIT || 'test',
    project: HEROKU_APP_NAME || SERVICE
  }
  const newrelic = {
    key: NEW_RELIC_LICENSE_KEY || false
  }
  const wallet = {}
  const testingCohorts = TESTING_COHORTS ? TESTING_COHORTS.split(',') : []
  const currency = {
    altcoins: CRYPTO_CURRENCIES ? CRYPTO_CURRENCIES.split(',') : [ 'BAT', 'BTC', 'ETH', 'LTC' ],
    url: BAT_RATIOS_URL,
    access_token: BAT_RATIOS_TOKEN
  }

  const url2Parse = NODE_ENV === 'production' ? ('https://' + HOST) : ('http://' + '127.0.0.1' + ':' + PORT)
  const server = url.parse(url2Parse)
  let slack = null
  let prometheus = null
  let redeemer = null
  let publishers = null
  let balance = null
  let captcha = null
  let referrals = null
  let postgres = null
  let ledger = null

  if (BAT_SETTLEMENT_ADDRESS) {
    wallet.settlementAddress = {
      BAT: BAT_SETTLEMENT_ADDRESS || '0x7c31560552170ce96c4a7b018e93cddc19dc61b6'
    }
  }

  if (BAT_ADS_PAYOUT_ADDRESS) {
    wallet.adsPayoutAddress = {
      BAT: BAT_ADS_PAYOUT_ADDRESS || '0x7c31560552170ce96c4a7b018e93cddc19dc61b6'
    }
  }

  if (SLACK_WEBHOOK) {
    slack = {
      webhook: SLACK_WEBHOOK,
      channel: SLACK_CHANNEL || '#bat-bot',
      icon_url: SLACK_ICON_URL || 'https://github.com/brave-intl/bat-ledger/raw/master/documentation/favicon.png'
    }
  }

  if (GITHUB_ORG) {
    login.github = {
      organization: GITHUB_ORG,
      world: GITHUB_LOGIN_WORLD || '/documentation',
      bye: GITHUB_LOGIN_BYE || 'https://example.com',
      clientId: GITHUB_CLIENT_ID,
      clientSecret: GITHUB_CLIENT_SECRET,
      ironKey: IRON_KEYPASS || 'cookie-encryption-password-at-least-32-octets',
      isSecure: GITHUB_FORCE_HTTPS || false
    }
  }

  if (DYNO) {
    prometheus = {
      label: SERVICE + '.' + DYNO,
      redis: REDIS2_URL || REDIS_URL || false
    }
  }

  const services = {
    ledger: {

      f: () => {
        if (COINBASE_WIDGET_CODE) {
          wallet.coinbase = {
            widgetCode : COINBASE_WIDGET_CODE
          }
        }

        if (REDEEMER_URL) {
          redeemer = {
            url: REDEEMER_URL || 'http://127.0.0.1:3333',
            access_token: REDEEMER_TOKEN || '00000000-0000-4000-0000-000000000000'
          }
        }
        if (REDEEMER_CARD_ID) {
          redeemer = {
            cardId: REDEEMER_CARD_ID
          }
        }
        if (BALANCE_URL) {
          balance = {
            url: BALANCE_URL || 'http://127.0.0.1:3000',
            access_token: BALANCE_TOKEN  || '00000000-0000-4000-0000-000000000000'
          }
        }
        if (CAPTCHA_URL) {
          captcha = {
            url: CAPTCHA_URL   || 'http://127.0.0.1:3334',
            access_token: CAPTCHA_TOKEN || '00000000-0000-4000-0000-000000000000',
            bypass: CAPTCHA_BYPASS_TOKEN || '00000000-0000-4000-0000-000000000000'
          }
        }
        setupPublishers()
        setupUphold()
      }
    },

    eyeshade: {

      f: () => {
        referrals = {
          currency: REFERRALS_CURRENCY || 'USD',
          amount: REFERRALS_AMOUNT || 5
        }
        postgres = {
          url: DATABASE_URL || 'postgres://localhost/test',
          schemaVersionCheck: true
        }

        setupPublishers()
        setupUphold()
      }
    },

    balance: {

      f: () => {
        ledger = {
          url: LEDGER_URL || 'http://127.0.0.1:3001'
        }

        setupUphold()
      }
    }
  }
  const service = services[SERVICE]

  if (service && service.f) {
    service.f()
  }
  return {
    generate,
    altcurrency,
    cache,
    database,
    queue,
    sentry,
    newrelic,
    testingCohorts,
    currency,
    postgres,
    referrals,
    prometheus,
    wallet,
    slack,
    login,
    server,
    redeemer,
    publishers,
    captcha
  }

  function setupPublishers () {
    publishers = {}
    if (PUBLISHERS_URL) {
      const takeover = PUBLISHERS_TAKEOVER
      publishers = {
        url: PUBLISHERS_URL || 'http://127.0.0.1:3000',
        access_token: PUBLISHERS_TOKEN || '00000000-0000-4000-0000-000000000000',
        takeover: takeover ? booleanHash[takeover] : false
      }
    }
  }

  function setupUphold () {
    if (!UPHOLD_ACCESS_TOKEN && !UPHOLD_CLIENT_ID) return

    wallet.uphold = {
      accessToken: UPHOLD_ACCESS_TOKEN || 'none',
      clientId: UPHOLD_CLIENT_ID || 'none',
      clientSecret: UPHOLD_CLIENT_SECRET || 'none',
      environment: UPHOLD_ENVIRONMENT || 'sandbox'
    }
  }
}
