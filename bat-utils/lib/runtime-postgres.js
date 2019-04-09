const SDebug = require('sdebug')
const pg = require('pg')

const Pool = pg.Pool
const debug = new SDebug('postgres')

module.exports = Postgres

Postgres.prototype = {
  connect: function () {
    return this.pool.connect()
  },
  query: async function (text, params) {
    const start = Date.now()
    const ret = await this.pool.query(text, params)
    const duration = Date.now() - start
    debug('executed query', { text, duration, rows: ret.rowCount })
    return ret
  },
  transaction: async function (fn, exceptionHandler = handleException) {
    const postgres = this
    const runtime = postgres.runtime
    const client = await postgres.connect()
    let result = null
    try {
      await client.query('BEGIN')
      result = await fn(client)
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      await exceptionHandler(e, client, runtime)
      throw e
    } finally {
      client.release()
    }
    return result
  }
}

function handleException (e, client, runtime) {
  runtime.captureException(e)
}

function Postgres (config, runtime) {
  if (!(this instanceof Postgres)) return new Postgres(config, runtime)

  if (!config.postgres) return
  this.pool = new Pool({ connectionString: config.postgres.url, ssl: process.env.NODE_ENV === 'production' })
  this.runtime = runtime

  this.pool.on('error', (err, client) => {
    debug('postgres', { message: err })
    throw err
  })

  if (config.postgres.schemaVersionCheck) {
    this.query('select id from migrations order by id desc limit 1;', []).then((resp) => {
      if (resp.rowCount !== 1) {
        throw Error('db has not been initialized')
      }
      const currentVersion = resp.rows[0].id
      const targetVersion = config.postgres.schemaVersion
      if (targetVersion !== currentVersion) {
        throw Error(`db schema is too old, saw ${currentVersion} expected ${targetVersion}`)
      }
    })
  }
}
