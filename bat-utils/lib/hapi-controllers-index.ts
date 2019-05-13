
import underscore from 'underscore'

const routes = async (debug, runtime, options) => {
  const entries = {}
  const routes = [
    { method: 'GET',
      path: '/',
      config: { handler: (request, reply) => { reply('ack.') } }
    }
  ]
  let errP, names

  const router = async (module) => {
    let routing = module.routes

    if (typeof module.initialize === 'function') routing = (await module.initialize(debug, runtime)) || routing

    if (!Array.isArray(routing)) return []

    routing.forEach(route => {
      const entry = route(runtime)
      const key = entry.method + ' ' + entry.path

      if (entries[key]) { debug('duplicate route ' + key) } else { entries[key] = true }
      routes.push(entry)
    })
  }

  if (options.controllers) {
    names = underscore.without(underscore.keys(options.controllers), 'index')

    for (let name of names) {
      try {
        await router(options.controllers[name])
      } catch (ex) {
        errP = true
        debug('error loading routes for built-in controller' + name + ': ' + ex.toString())
        console.log(ex.stack)
      }
    }
  }

  for (let mod of options.parentModules) {
    await router(mod)
  }

  if (errP) process.exit(1)

  return routes
}

export default {
  routes
}
