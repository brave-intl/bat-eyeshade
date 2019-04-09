'use strict'

import braveHapi from './extras-hapi.js'
import test from 'ava'

test('isSimpleTokenValid', async t => {
  t.false(braveHapi.isSimpleTokenValid([], ''))
  t.false(braveHapi.isSimpleTokenValid(['foo'], 'bar'))
  t.false(braveHapi.isSimpleTokenValid(['foo'], 'foobar'))
  t.false(braveHapi.isSimpleTokenValid(['foobar'], 'foo'))

  t.true(braveHapi.isSimpleTokenValid(['foo'], 'foo'))
  t.true(braveHapi.isSimpleTokenValid(['foo', 'bar'], 'foo'))
  t.true(braveHapi.isSimpleTokenValid(['foo', 'bar'], 'bar'))

  t.throws(() => {
    braveHapi.isSimpleTokenValid('foo', 'bar')
  })
  t.throws(() => {
    braveHapi.isSimpleTokenValid(['foo'], ['bar'])
  })
})
