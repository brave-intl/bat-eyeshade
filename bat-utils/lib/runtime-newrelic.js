let singleton
const tldjs = require('tldjs')
const os = require('os')
const path = require('path')

const {
  NODE_ENV,
  HOST,
  SERVICE
} = require('../../env')

module.exports = createNewrelic

createNewrelic.setupNewrelic = setup

function Newrelic (config, runtime) {
  let newrelic = {
    startBackgroundTransaction: (name, group, cb) => { return ((cb || group)()) },
    getTransaction: () => { return { end: () => {} } },
    noticeError: (ex, params) => {},
    recordCustomEvent: (eventType, attributes) => {}
  }

  if ((!config.newrelic) || (!config.newrelic.key)) return newrelic

  if (!config.newrelic.appname) {
    if (NODE_ENV === 'production') throw new Error('config.newrelic.appname undefined')
    return newrelic
  }

  process.env.NEW_RELIC_APP_NAME = config.newrelic.appname
  process.env.NEW_RELIC_LICENSE_KEY = config.newrelic.key
  process.env.NEW_RELIC_LOG = config.newrelic.log || 'stdout'
  process.env.NEW_RELIC_NO_CONFIG_FILE = true

  return require('newrelic')
}

function createNewrelic (config, runtime) {
  if (!singleton) singleton = new Newrelic(config, runtime)

  return singleton
}

function setup (config, fName) {
  if (config.newrelic) {
    if (!config.newrelic.appname) {
      const appname = path.parse(fName).name

      if (NODE_ENV === 'production') {
        config.newrelic.appname = appname + '.' + tldjs.getSubdomain(HOST)
      } else {
        config.newrelic.appname = 'bat-' + SERVICE + '-' + appname + '@' + os.hostname()
      }
    }
    process.env.NEW_RELIC_APP_NAME = config.newrelic.appname

    createNewrelic(config)
  }
}
