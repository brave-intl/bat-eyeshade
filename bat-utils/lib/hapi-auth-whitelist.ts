import path from 'path'

import boom from 'boom'
import netmask from 'netmask'
import underscore from 'underscore'

const { Netmask } = netmask

const whitelist = process.env.IP_WHITELIST && process.env.IP_WHITELIST.split(',')

let authorizedAddrs = whitelist && [ '127.0.0.1' ]
let authorizedBlocks = whitelist && []

if (whitelist) {
  whitelist.forEach((entry) => {
    if ((entry.indexOf('/') !== -1) || (entry.split('.').length !== 4)) return authorizedBlocks.push(new Netmask(entry))

    authorizedAddrs.push(entry)
  })
}

const internals = {
  implementation: (server, options) => { return { authenticate } }
}

const authorizedP = (ipaddr) => {
  if ((authorizedAddrs) &&
        ((authorizedAddrs.indexOf(ipaddr) !== -1) ||
         (underscore.find(authorizedBlocks, (block) => { return block.contains(ipaddr) })))) return true
}

// NOTE This function trusts the final IP address in X-Forwarded-For
//      This is reasonable only when running behind a load balancer that correctly sets this header
//      and there is no way to directly access the web nodes
const ipaddr = (request) => {
  // https://en.wikipedia.org/wiki/X-Forwarded-For    X-Forwarded-For: client, proxy1, proxy2
  // Since it is easy to forge an X-Forwarded-For field the given information should be used with care.
  // The last IP address is always the IP address that connects to the last proxy, which means it is the most reliable source of information.

  const forwardedFor = request.headers['x-forwarded-for']
  if (forwardedFor) {
    const forwardedIps = forwardedFor.split(',')
    return forwardedIps[forwardedIps.length - 1].trim() || request.info.remoteAddress
  } else {
    return request.info.remoteAddress
  }
}

const authenticate = (request, reply) => {
  const ip = ipaddr(request)
  let result

  if ((authorizedAddrs) &&
        (authorizedAddrs.indexOf(ip) === -1) &&
        (!underscore.find(authorizedBlocks, (block) => { return block.contains(ip) }))) return reply(boom.notAcceptable())

  try {
    result = reply.continue({ credentials: { ipaddr: ip } })
  } catch (ex) {
/* something odd with reply.continue not allowing any arguments... */
    result = reply.continue()
  }
  return result
}

const register = (server, options, next) => {
  server.auth.scheme('whitelist', internals.implementation)
  server.auth.strategy('whitelist', 'whitelist', {})
  next()
}

register.attributes = {
  pkg: require(path.join(__dirname, '..', 'package.json'))
}

export default {
  authorizedP,
  ipaddr,
  authenticate,
  register
}
