
import hapiAuthWhitelist from './lib/hapi-auth-whitelist'
import hapiControllersIndex from './lib/hapi-controllers-index'
import hapiControllersLogin from './lib/hapi-controllers-login'
import hapiControllersPing from './lib/hapi-controllers-ping'
import hapiServer from './lib/hapi-server'

const controllers = {
  index: hapiControllersIndex,
  login: hapiControllersLogin,
  ping: hapiControllersPing
}
const auth = {
  whitelist: hapiAuthWhitelist
}

export default {
  server: hapiServer,
  controllers,
  auth
}
