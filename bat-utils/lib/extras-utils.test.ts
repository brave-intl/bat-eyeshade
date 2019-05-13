'use strict';

import test from 'ava';
import { ObjectID } from 'mongodb';
import utils from './extras-utils';
import dotenv from 'dotenv';
const { surveyorChoices, createdTimestamp, timeout, documentOlderThan, isYoutubeChannelId, normalizeChannel } = utils
dotenv.config();
const objectId = ObjectID('5b11685dd28b11258d50c1f4');
const objectDate = new Date('2018-06-01T15:38:05.000Z').getTime();
test('createdTimestamp', t => {
  t.plan(1);
  const fromId = createdTimestamp(objectId);
  t.is(fromId, objectDate);
});
test('timeout', t => {
  t.plan(1);
  let bool = false;
  timeout(495).then(() => {
    bool = true;
  });
  const justRight = timeout(500).then(() => {
    t.true(bool);
  });
  const tooLate = timeout(505).then(() => {
    throw new Error('bad timeout');
  });
  return Promise.race([justRight, tooLate]);
});
test('documentOlderThan', t => {
  t.plan(3);
  t.true(documentOlderThan(-1, objectDate, objectId));
  t.false(documentOlderThan(1, objectDate, objectId)); // lt not lte

  t.false(documentOlderThan(0, objectDate, objectId));
});
test('isYoutubeChannelId', t => {
  t.plan(3);
  t.true(isYoutubeChannelId('UCFNTTISby1c_H-rm5Ww5rZg'));
  t.false(isYoutubeChannelId('UCFNTTISby1c_H-rm5Ww5rZ'));
  t.false(isYoutubeChannelId('Brave'));
});
test('normalizeChannel', t => {
  t.plan(4);
  t.is(normalizeChannel('youtube#channel:UCFNTTISby1c_H-rm5Ww5rZg'), 'youtube#channel:UCFNTTISby1c_H-rm5Ww5rZg');
  t.is(normalizeChannel('youtube#channel:Brave'), 'youtube#user:Brave');
  t.is(normalizeChannel('twitch#channel:Brave'), 'twitch#author:Brave');
  t.is(normalizeChannel('www.brave.com'), 'www.brave.com');
});
test('surveyorChoices', t => {
  t.plan(4);
  t.deepEqual(surveyorChoices(0.55), [6, 10, 14, 20, 40], 'increment is less than');
  t.deepEqual(surveyorChoices(0.5), [6, 10, 14, 20, 40], 'increment is equal to');
  t.deepEqual(surveyorChoices(2), [3, 5, 7, 10, 20], 'increment can be above range');
  t.deepEqual(surveyorChoices(0.02), [30, 50, 70, 100], 'increment can be below range');
});