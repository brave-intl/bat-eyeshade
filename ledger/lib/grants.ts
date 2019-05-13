import _ from 'underscore'
const { WALLET_COOLDOWN_HRS } = process.env

export default {
  defaultCooldownHrs,
  cooldownOffset
}

function defaultCooldownHrs (hours?) {
  const hrs = _.isUndefined(hours) ? WALLET_COOLDOWN_HRS : hours
  return hrs ? (+hrs || 0) : 24
}

function cooldownOffset (hours = defaultCooldownHrs()) {
  return hours * 60 * 60 * 1000
}
