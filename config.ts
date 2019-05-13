import * as url from 'url'
const services = {
  ledger: {
    portno: 3001,

    f: () => {
      if (process.env.COINBASE_WIDGET_CODE) {
        exporting.wallet.coinbase = { widgetCode: process.env.COINBASE_WIDGET_CODE }
      }

      if (process.env.REDEEMER_URL) {
        exporting.redeemer =
        { url: process.env.REDEEMER_URL || 'http://127.0.0.1:3333',
          access_token: process.env.REDEEMER_TOKEN || '00000000-0000-4000-0000-000000000000'
        }
      }
      if (process.env.REDEEMER_CARD_ID) {
        exporting.redeemer =
        { cardId: process.env.REDEEMER_CARD_ID
        }
      }
      if (process.env.BALANCE_URL) {
        exporting.balance =
          { url: process.env.BALANCE_URL || 'http://127.0.0.1:3000',
            access_token: process.env.BALANCE_TOKEN || '00000000-0000-4000-0000-000000000000'
          }
      }
      if (process.env.CAPTCHA_URL) {
        exporting.captcha =
        { url: process.env.CAPTCHA_URL || 'http://127.0.0.1:3334',
          access_token: process.env.CAPTCHA_TOKEN || '00000000-0000-4000-0000-000000000000',
          bypass: process.env.CAPTCHA_BYPASS_TOKEN || '00000000-0000-4000-0000-000000000000'
        }
      }
      publishers()
      uphold()
    }
  },

  eyeshade: {
    portno: 3002,

    f: () => {
      exporting.referrals =
        { currency: process.env.REFERRALS_CURRENCY || 'USD',
          amount: process.env.REFERRALS_AMOUNT || 5
        }
      exporting.postgres =
        { url: process.env.DATABASE_URL || 'postgres://localhost/test',
          schemaVersion: '',
          schemaVersionCheck: true
        }

      publishers()
      uphold()
    }
  },

  balance: {
    portno: 3003,

    f: () => {
      exporting.ledger = {
        url: process.env.LEDGER_URL || 'http://127.0.0.1:3001'
      }

      uphold()
    }
  }
}

const publishers = () => {
  exporting.publishers = {}
  if (process.env.PUBLISHERS_URL) {
    const takeover = process.env.PUBLISHERS_TAKEOVER
    exporting.publishers =
      { url: process.env.PUBLISHERS_URL || 'http://127.0.0.1:3000',
        access_token: process.env.PUBLISHERS_TOKEN || '00000000-0000-4000-0000-000000000000',
        takeover: takeover ? ({ true: true, false: false })[takeover] : false
      }
  }
}

const uphold = () => {
  if ((!process.env.UPHOLD_ACCESS_TOKEN) && (!process.env.UPHOLD_CLIENT_ID)) return

  exporting.wallet.uphold =
  { accessToken: process.env.UPHOLD_ACCESS_TOKEN || 'none',
    clientId: process.env.UPHOLD_CLIENT_ID || 'none',
    clientSecret: process.env.UPHOLD_CLIENT_SECRET || 'none',
    environment: process.env.UPHOLD_ENVIRONMENT || 'sandbox'
  }
}

const service = services[process.env.SERVICE]
if (!service) {
  throw new Error('invalid process.env.SERVICE=' + process.env.SERVICE)
}

process.env.PORT = process.env.PORT || service.portno

const SERVICE = process.env.SERVICE.toUpperCase()
const envKeys = ['MONGODB_URI', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'SLACK_CHANNEL', 'SLACK_ICON_URL']
envKeys.forEach((v) => {
  process.env[v] = process.env[v] || process.env[SERVICE + '_' + v]
})

const exporting = {
  postgres: <any>null,
  prometheus: <any>null,
  slack: <any>null,
  publishers: <any>null,
  referrals: <any>null,
  captcha: <any>null,
  balance: <any>null,
  redeemer: <any>null,
  ledger: <any>null,
  wallet: <any>{},
  server: <any>null,
  altcurrency: process.env.ALTCURRENCY || 'BAT',
  cache: {
    redis: {
      url: process.env.REDIS_URL || 'redis://localhost:6379'
    }
  },
  database: {
    mongo: process.env.MONGODB_URI || 'localhost/test'
  },
  login: <any>{ github: false },
  queue: {
    rsmq: process.env.REDIS_URL || 'redis://localhost:6379'
  },
  sentry: {
    dsn: process.env.SENTRY_DSN || false,
    slug: process.env.HEROKU_SLUG_COMMIT || 'test',
    project: process.env.HEROKU_APP_NAME || process.env.SERVICE
  },
  newrelic: {
    key: process.env.NEW_RELIC_LICENSE_KEY || false
  },
  testingCohorts: process.env.TESTING_COHORTS ? process.env.TESTING_COHORTS.split(',') : [],
  currency: {
    url: process.env.BAT_RATIOS_URL,
    access_token: process.env.BAT_RATIOS_TOKEN
  }
}

if (service.f) service.f()
export default exporting

if (process.env.NODE_ENV === 'production') {
  exporting.server = url.parse('https://' + process.env.HOST)
} else {
  exporting.server = url.parse('http://' + '127.0.0.1' + ':' + process.env.PORT)
}

if (process.env.BAT_SETTLEMENT_ADDRESS) {
  exporting.wallet.settlementAddress =
  { BAT: process.env.BAT_SETTLEMENT_ADDRESS || '0x7c31560552170ce96c4a7b018e93cddc19dc61b6' }
}

if (process.env.BAT_ADS_PAYOUT_ADDRESS) {
  exporting.wallet.adsPayoutAddress =
  { BAT: process.env.BAT_ADS_PAYOUT_ADDRESS || '0x7c31560552170ce96c4a7b018e93cddc19dc61b6' }
}

if (process.env.SLACK_WEBHOOK) {
  exporting.slack =
  { webhook: process.env.SLACK_WEBHOOK,
    channel: process.env.SLACK_CHANNEL || '#bat-bot',
    icon_url: process.env.SLACK_ICON_URL || 'https://github.com/brave-intl/bat-ledger/raw/master/documentation/favicon.png'
  }
}

if (process.env.GITHUB_ORG) {
  exporting.login.github =
  { organization: process.env.GITHUB_ORG,
    world: process.env.GITHUB_LOGIN_WORLD || '/documentation',
    bye: process.env.GITHUB_LOGIN_BYE || 'https://example.com',
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    ironKey: process.env.IRON_KEYPASS || 'cookie-encryption-password-at-least-32-octets',
    isSecure: process.env.GITHUB_FORCE_HTTPS || false
  }
}

if (process.env.DYNO) {
  exporting.prometheus =
    { label: process.env.SERVICE + '.' + process.env.DYNO,
      redis: process.env.REDIS2_URL || process.env.REDIS_URL || false
    }
}
