'use strict'

import { serial as test } from 'ava'
import Postgres from 'bat-utils/lib/runtime-postgres'
const {
  BAT_POSTGRES_URL
} = require('../../env')
const postgres = new Postgres({ postgres: { url: BAT_POSTGRES_URL } })

test('migrations table is up-to-date', async t => {
  const latestInMigrationsTable = (await postgres.query('select id from migrations order by id desc limit 1;', [])).rows[0].id
  const latestInMigrationsFolder = require('../../eyeshade/migrations/current')

  t.true(latestInMigrationsTable === latestInMigrationsFolder)
})
