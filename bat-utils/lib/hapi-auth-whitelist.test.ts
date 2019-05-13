'use strict';

import whitelist from './hapi-auth-whitelist';
import test from 'ava';
import dotenv from 'dotenv';
dotenv.config();
test('ipaddr', async t => {
  let request = <any>{
    headers: {
      'x-forwarded-for': '127.0.0.1,12.12.12.12'
    },
    info: {
      remoteAddress: '123.123.123.123'
    }
  };
  t.true(whitelist.ipaddr(request) === '12.12.12.12');
  request = {
    headers: {
      'x-forwarded-for': '127.0.0.1, 12.12.12.12'
    },
    info: {
      remoteAddress: '123.123.123.123'
    }
  };
  t.true(whitelist.ipaddr(request) === '12.12.12.12');
  request = {
    headers: {},
    info: {
      remoteAddress: '123.123.123.123'
    }
  };
  t.true(whitelist.ipaddr(request) === '123.123.123.123');
  request = {
    headers: {
      'x-forwarded-for': ' '
    },
    info: {
      remoteAddress: '123.123.123.123'
    }
  };
  t.true(whitelist.ipaddr(request) === '123.123.123.123');
});