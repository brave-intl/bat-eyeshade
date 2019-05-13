import bson from 'bson'
import * as mongodb from 'mongodb'
import GridStream from 'gridfs-stream'
import monk from 'monk'
import stringify from 'json-stringify-safe'
import underscore from 'underscore'
import SDebug from 'sdebug'
const debug = new SDebug('database')
const GridStore = mongodb.GridStore
const Logger = mongodb.Logger

const Database = function (config, runtime): void {
  if (!(this instanceof Database)) return new Database(config, runtime)

  if (!config.database) return

  if (config.database.mongo) config.database = config.database.mongo
  this.config = config.database
  this.db = monk(this.config)

  Logger.setCurrentLogger((msg, context) => {
    if (context.type !== 'debug') debug(context.className.toLowerCase(), context.message)
  })
  this.db.addMiddleware(this.middleware)
}

Database.prototype.middleware = function (context) {
  const collection = context.collection

  return (next) => {
    return (args, method) => {
      const ndebug = (collection && collection._debug) || debug
      const params = args.query || (args.col && args.col.s && args.col.s.name) || underscore.keys(args)
      let prefix = method
      let query = stringify(params)

      if (collection) {
        prefix = collection.name + '.' + prefix
        if (params === collection.name) query = ''
      }
      if (query) prefix += ' ' + query

      return next(args, method).then((result) => {
        let values

        if (result) {
          if (result._id) values = result._id
          else if (Array.isArray(result) && (typeof result.length === 'number')) {
            values = []
            if (result.length < 4) { result.forEach((entry) => { if (entry._id) values.push(entry._id) }) }
            if (result.length === values.length) values = stringify(values)
            else values = result.length + ' result' + (result.length !== 1 ? 's' : '')
          }
        }

        ndebug('%s: %s', prefix, (values || stringify(result)))
        return result
      })
    }
  }
}

Database.prototype.file = async function (filename, mode, options) {
  options = underscore.extend(options || {}, { safe: true })

  if (mode !== 'r') return (new GridStore(this.db._db, filename, mode, options).open())

  return new Promise((resolve, reject) => {
    GridStore.exist(this.db._db, filename, (err, result) => {
      let gridStore

      if (err) return reject(err)

      if (!result) return resolve(null)

      gridStore = new GridStore(this.db._db, filename, mode, options)
      gridStore.open((err, result) => {
        if (err) return reject(err)

        resolve(result)
      })
    })
  })
}

Database.prototype.purgeSince = async function (debug, runtime, timestamp) {
  const reports = this.get('fs.files', debug)
  let entries, names

  await reports.createIndex({ uploadDate: 1 }, { unique: false })

  entries = await reports.find({
    _id: { $lte: bson.ObjectId(Math.floor(timestamp / 1000.0).toString(16) + '0000000000000000') }
  })
  debug('purgeSince', { count: entries.length })

  if (entries.length === 0) return

  names = underscore.map(entries, (entry) => { return entry._id })
  return new Promise((resolve, reject) => {
    GridStore.unlink(this.db._db, names, (err) => {
      if (err) return debug('purgeSince', err)

      resolve()
    })
  })
}

Database.prototype.source = function (options) {
  return GridStream(this.db._db, mongodb).createReadStream(options)
}

Database.prototype.get = function (collection, debug, options) {
  const ndebug = new SDebug('monk:queries')
  const result = this.db.get(collection, { cache: false })

  if ((options && options.log) !== false) {
    ndebug.initial = debug.initial
    result._debug = ndebug
  } else {
    // empty logger
    result._debug = () => {}
  }

  return result
}

// TODO: annotate this function and give it a more descriptive name
Database.prototype.form = function (index) {
  let result = ''

  underscore.keys(index).forEach(function (key) { result += '_' + key + '_' + index[key] })
  return result.substr(1)
}

// TODO: annotate this function and give it a more descriptive name
Database.prototype.gather = function (entry) {
  const gather = (list) => {
    const result = []

    if (list) list.forEach(function (index) { result.push(this.form(index)) }.bind(this))

    return result
  }

  return gather(entry.unique).concat(gather(entry.others), gather(entry.raw))
}

Database.prototype.checkIndices = async function (debug, entries) {
  const gather = this.gather.bind(this)
  const form = this.form.bind(this)

  await Promise.all(entries.map(async (entry) => {
    const category = entry.category
    let doneP, indices, status

    try { indices = underscore.keys(await category.indexes() || {}) } catch (ex) { indices = [] }
    if (indices.indexOf(entry.property + '_1') === -1) status = 'being created'
    else {
      doneP = true
      gather(entry).forEach((index) => { if (indices.indexOf(index) === -1) doneP = false })
      status = doneP ? 'already created' : 'being updated'
    }

    debug(entry.name + ' indices ' + status)
    if (doneP) return

    try {
      if (indices.length === 0) { await category.insert(entry.empty) }
      const {
        unique = [],
        others = [],
        raw = []
      } = entry
      const uniqueCreates = unique.map(async (index) => {
        if (indices.indexOf(form(index)) === -1) await category.createIndex(index, { unique: true })
      })

      const othersCreates = others.map(async (index) => {
        if (indices.indexOf(form(index)) === -1) await category.createIndex(index, { unique: false })
      })

      const rawCreates = raw.map(async (index) => {
        if (indices.indexOf(form(index)) === -1) await category.createIndex(index)
      })
      await Promise.all(uniqueCreates.concat(othersCreates, rawCreates))
    } catch (ex) {
      debug('unable to create ' + entry.name + ' ' + entry.property + ' index', ex)
    }
  }))
}

export default Database
