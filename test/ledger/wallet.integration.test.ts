import {
  serial as test
} from 'ava'
import uuidV4 from 'uuid/v4'
import {
  ok,
  cleanDbs,
  connectToDb,
  ledgerAgent
} from '../utils'
import {
  ObjectID
} from 'bson'

const statsURL = '/v2/wallet/stats'
const frozenDay = today()
const DAY = 1000 * 60 * 60 * 24

test.afterEach.always(async () => { await cleanDbs() })

test('a stats endpoint exists', async (t) => {
  const url = `${statsURL}/${frozenDay.toISOString()}`
  const {
    body
  } = await ledgerAgent
    .get(url)
    .expect(ok)
  t.deepEqual([], body)
})

test('stats endpoint returns wallet stats', async (t) => {
  await insert(null)
  const url = `${statsURL}/${frozenDay.toISOString()}`
  const {
    body
  } = await ledgerAgent
    .get(url)
    .expect(ok)
  t.deepEqual(body, [walletExpectation(frozenDay)])
})

test('stats endpoint returns wallet within 24 hr period', async (t) => {
  let body
  await insert(frozenDay)
  const prevDay = new Date(+frozenDay - (+frozenDay % DAY) - DAY)
  await insert(prevDay)
  ;({
    body
  } = await ledgerAgent
    .get(`${statsURL}/${frozenDay.toISOString()}`)
    .expect(ok))
  t.deepEqual(body, [walletExpectation(frozenDay)])
  ;({
    body
  } = await ledgerAgent
    .get(`${statsURL}/${prevDay.toISOString()}`)
    .expect(ok))
  t.deepEqual(body, [walletExpectation(prevDay)])
})

test('can return a [) range', async (t) => {
  const truncatedDay = new Date(+frozenDay - (+frozenDay % DAY))
  const prevDay = new Date(+truncatedDay - DAY)
  const nextDay = new Date(+truncatedDay - -DAY)
  await insert(truncatedDay)
  await insert(prevDay)
  await insert(nextDay)
  const url = `${statsURL}/${prevDay.toISOString()}/${nextDay.toISOString()}`
  const {
    body
  } = await ledgerAgent
    .get(url)
    .expect(ok)
  t.deepEqual(body, [walletExpectation(truncatedDay), walletExpectation(prevDay)])
})

function walletExpectation (day, wallets = 1) {
  return {
    activeGrant: 0,
    anyFunds: 0,
    contributed: 0,
    created: byDay(day),
    walletProviderBalance: '0',
    walletProviderFunded: 0,
    wallets
  }
}

function byDay (d) {
  const date = new Date(d)
  const iso = date.toISOString()
  const split = iso.split('T')
  return split[0]
}

async function insert (date) {
  const db = await connectToDb('ledger')
  const wallets = db.collection('wallets', () => {})
  await wallets.insert({
    paymentId: uuidV4(),
    _id: ObjectID.createFromTime((date || new Date()) / 1000),
    balances: {
      confirmed: '0'
    }
  })
}

function today () {
  const DAY = 1000 * 60 * 60 * 24
  const then = new Date()
  return new Date(+then - (+then % DAY))
}
