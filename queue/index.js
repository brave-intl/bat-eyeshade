const dotenv = require('dotenv')
const fs = require('fs')
const path = require('path')
dotenv.config()
const object = make(process.env)
const json = JSON.stringify(object, null, 2)
const pathtoconfig = path.join(__dirname, 'index.json')
fs.writeFileSync(pathtoconfig, json)
module.exports = object

function make ({
  ARENA_REDIS_URL: redis
}) {
  const hostId = 'eyeshade-workers'
  const type = 'bee'
  return {
    queues: [
      'settlement-report',
      'referral-report',
      'surveyor-frozen-report',
      'grant-report',
      'redeem-report',
      'persona-report',
      'surveyor-report',
      'voting-report',
      'contribution-report',
      'wallet-report'
    ].map((name) => ({
      hostId,
      type,
      name,
      redis
    }))
  }
}
