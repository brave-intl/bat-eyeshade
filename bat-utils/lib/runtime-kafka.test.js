'use strict'

const Kafka = require('./runtime-kafka')
const test = require('ava')

test('can create kafka consumer', async (t) => {
  process.env.KAFKA_CONSUMER_GROUP = 'test-consumer'

  const runtime = {
    config: require('../../config')
  }
  const producer = new Kafka(runtime.config, runtime)
  await producer.connect()

  const consumer = new Kafka(runtime.config, runtime)
  const messagesPromise = new Promise(resolve => {
    consumer.on('test-topic', async (messages) => {
      resolve(messages)
    })
  })
  await consumer.consume()

  await producer.send('test-topic', 'hello world')

  const messages = await messagesPromise

  t.is(messages.length, 1)
  t.is(messages[0].value, 'hello world')
})
