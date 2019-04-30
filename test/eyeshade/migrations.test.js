'use strict'

import { serial as test } from 'ava'
import {
  eyeshadeRuntime
} from '../utils'

test('migrations table is up-to-date', async t => {
  const latestInMigrationsTable = (await eyeshadeRuntime.postgres.query('select id from migrations order by id desc limit 1;', [])).rows[0].id
  const latestInMigrationsFolder = require('../../eyeshade/migrations/current')

  t.true(latestInMigrationsTable === latestInMigrationsFolder)
})
