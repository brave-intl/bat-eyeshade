import SDebug from 'sdebug'
import pg from 'pg'

const Pool = pg.Pool
const debug = new SDebug('postgres')

const Postgres = function (config, runtime?): void {
  if (!(this instanceof Postgres)) return new Postgres(config, runtime)

  if (!config.postgres) return
  this.pool = new Pool({ connectionString: config.postgres.url, ssl: process.env.NODE_ENV === 'production' })

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
  }
}

export default Postgres
