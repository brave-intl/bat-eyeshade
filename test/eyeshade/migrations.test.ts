'use strict'

import { serial as test } from 'ava'
import Postgres from 'bat-utils/lib/runtime-postgres'
import latestInMigrationsFolder from '../../eyeshade/migrations/current'

const postgres = new Postgres({ postgres: { url: process.env.BAT_POSTGRES_URL } })

test('migrations table is up-to-date', async t => {
  const latestInMigrationsTable = (await postgres.query('select id from migrations order by id desc limit 1;', [])).rows[0].id

  t.true(latestInMigrationsTable === latestInMigrationsFolder)
})
