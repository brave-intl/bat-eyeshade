const url = require('url')

const SDebug = require('sdebug')
const debug = new SDebug('pg:queries')
const pg = require('pg')

const SQL = function (config, runtime) {
  if (!(this instanceof SQL)) return new SQL(config, runtime)

  const query = pg.Client.prototype.query

  this.config = config.sql && config.sql.postgres
  if (!this.config) return

  this.pool = new pg.Pool(this.config).on('error', (err, client) => {
    debug('sql', { database: this.config, message: err.message })
    throw err
  })
  this.pool.connect((err, client, done) => {
    let parts

    if (err) {
      debug('sql', { database: this.config, message: err.message })
      throw err
    }

    parts = url.parse(this.config.connectionString, true)

    debug('sql', { host: parts.host, pathname: parts.pathname, properties: parts.query })
  })

  pg.Client.prototype.query = function (config, values, callback) {
    debug('%s: %s', config, JSON.stringify(values))

    return query.apply(this, arguments)
  }
}

module.exports = SQL
