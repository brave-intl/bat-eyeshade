'use strict';

import database from './runtime-database';
import test from 'ava';
import dotenv from 'dotenv';
dotenv.config();
test('database.form', async t => {
  const db = database.prototype;
  t.is(db.form({
    abc: 'def'
  }), 'abc_def');
  t.is(db.form({
    abc: 'def',
    foo: 'bar'
  }), 'abc_def_foo_bar');
  t.is(db.form({}), '');
});
test('database.gather', async t => {
  const db = database.prototype;
  const entry = {
    name: 'voting',
    property: 'surveyorId_1_publisher_1_cohort',
    unique: [{
      surveyorId: 1,
      publisher: 1,
      cohort: 1
    }],
    others: [{
      counts: 1
    }, {
      timestamp: 1
    }, {
      exclude: 1
    }, {
      hash: 1
    }, {
      counts: 1
    }, {
      altcurrency: 1,
      probi: 1
    }, {
      altcurrency: 1,
      exclude: 1,
      probi: 1
    }, {
      owner: 1,
      altcurrency: 1,
      exclude: 1,
      probi: 1
    }, {
      publisher: 1,
      altcurrency: 1,
      exclude: 1,
      probi: 1
    }]
  };
  t.deepEqual(db.gather(entry), ['surveyorId_1_publisher_1_cohort_1', 'counts_1', 'timestamp_1', 'exclude_1', 'hash_1', 'counts_1', 'altcurrency_1_probi_1', 'altcurrency_1_exclude_1_probi_1', 'owner_1_altcurrency_1_exclude_1_probi_1', 'publisher_1_altcurrency_1_exclude_1_probi_1']);
});