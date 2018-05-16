'use strict'

import test from 'ava'
import request from 'supertest'
import dotenv from 'dotenv'
dotenv.config()
const SERVER_URL = process.env.BAT_EYESHADE_SERVER
const TestHelper = require('./test-helper')

test.before(async t => {
  await TestHelper.setupEyeshadeDb(t)
})

test('eyeshade POST /v2/owners', async t => {
  const PATH = '/v2/owners'

  t.plan(4)

  const dataPublisherWithYouTube = {
    "ownerId": "publishers#uuid:8eb1efca-a648-5e37-b328-b298f232d70f",
    "contactInfo": {
      "name": "Alice the Youtuber",
      "phone": "+14159001420",
      "email": "alice2@spud.com"
    },
    "channels": [{
      "channelId": "youtube#channel:323541525412313421"
    }]
  }

  await TestHelper.assertChangeNumber(t,
    async () => await request(SERVER_URL).post(PATH)
      .set('Authorization', 'Bearer foobarfoobar')
      .send(dataPublisherWithYouTube)
      .expect(200),
    async () => await t.context.publishers.count({'providerName': 'youtube'}),
    1,
    'can add YouTube channels')

  await TestHelper.assertChangeNumber(t,
    async () => await request(SERVER_URL).post(PATH)
      .set('Authorization', 'Bearer foobarfoobar')
      .send(dataPublisherWithYouTube)
      .expect(200),
    async () => await t.context.publishers.count({'providerName': 'youtube'}),
    0,
    'does not double add the same YouTube channel')


  const dataPublisherWithTwitch = {
    "ownerId": "publishers#uuid:20995cae-d0f7-50b9-aa42-05ea04ab28be",
    "contactInfo": {
      "name": "Alice the Twitcher",
      "phone": "+14159001420",
      "email": "aliceTwitch@spud.com"
    },
    "channels": [{
      "channelId": "twitch#channel:twtwtw",
      "authorizerName": "TwTwTw"
    }]
  }

  await TestHelper.assertChangeNumber(t,
    async () => await request(SERVER_URL).post(PATH)
      .set('Authorization', 'Bearer foobarfoobar')
      .send(dataPublisherWithTwitch)
      .expect(200),
    async () => await t.context.publishers.count({'providerName': 'twitch'}),
    1,
    'can add Twitch channels')

  await TestHelper.assertChangeNumber(t,
    async () => await request(SERVER_URL).post(PATH)
      .set('Authorization', 'Bearer foobarfoobar')
      .send(dataPublisherWithTwitch)
      .expect(200),
    async () => await t.context.publishers.count({'providerName': 'twitch'}),
    0,
    'does not double add the same Twitch channel')
})