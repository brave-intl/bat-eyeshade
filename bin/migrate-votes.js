#!/usr/bin/env node
"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

var _regenerator = _interopRequireDefault(require("@babel/runtime/regenerator"));

var _asyncToGenerator2 = _interopRequireDefault(require("@babel/runtime/helpers/asyncToGenerator"));

var BigNumber = require('bignumber.js');

var Database = require('bat-utils/lib/runtime-database');

var SDebug = require('sdebug');

var debug = new SDebug('migrate-transaction-table');

var uuidv5 = require('uuid/v5');

var Postgres = require('bat-utils/lib/runtime-postgres');

var _require = require('bat-utils/lib/extras-utils'),
    createdTimestamp = _require.createdTimestamp,
    normalizeChannel = _require.normalizeChannel;

function consume(_x, _x2) {
  return _consume.apply(this, arguments);
}

function _consume() {
  _consume = (0, _asyncToGenerator2["default"])(
  /*#__PURE__*/
  _regenerator["default"].mark(function _callee2(pg, votings) {
    return _regenerator["default"].wrap(function _callee2$(_context2) {
      while (1) {
        switch (_context2.prev = _context2.next) {
          case 0:
            return _context2.abrupt("return", Promise.all(votings.map(
            /*#__PURE__*/
            function () {
              var _ref = (0, _asyncToGenerator2["default"])(
              /*#__PURE__*/
              _regenerator["default"].mark(function _callee(voting) {
                var publisher, cohort, normalizedChannel, created, probi, fees;
                return _regenerator["default"].wrap(function _callee$(_context) {
                  while (1) {
                    switch (_context.prev = _context.next) {
                      case 0:
                        publisher = voting.publisher, cohort = voting.cohort;

                        if (!(publisher && cohort)) {
                          _context.next = 10;
                          break;
                        }

                        normalizedChannel = normalizeChannel(voting.publisher);
                        created = createdTimestamp(voting._id);
                        probi = voting.probi && new BigNumber(voting.probi.toString());
                        fees = voting.probi && new BigNumber(voting.fees.toString());
                        _context.next = 8;
                        return pg.pool.query('insert into votes (id, created_at, updated_at, cohort, amount, fees, tally, excluded, transacted, channel, surveyor_id) values ($1, to_timestamp($2), to_timestamp($3), $4, $5, $6, $7, $8, $9, $10, $11)', [// channel, cohort and surveyor group id should be unique per
                        uuidv5(normalizedChannel + voting.cohort + voting.surveyorId, 'f0ca8ff9-8399-493a-b2c2-6d4a49e5223a'), created / 1000, voting.timestamp.high_, voting.cohort, probi && probi.dividedBy('1e18').toString() || null, fees && fees.dividedBy('1e18').toString() || null, voting.counts, voting.exclude, false, normalizedChannel, voting.surveyorId]);

                      case 8:
                        _context.next = 11;
                        break;

                      case 10:
                        throw new Error('nani');

                      case 11:
                      case "end":
                        return _context.stop();
                    }
                  }
                }, _callee);
              }));

              return function (_x3) {
                return _ref.apply(this, arguments);
              };
            }())));

          case 1:
          case "end":
            return _context2.stop();
        }
      }
    }, _callee2);
  }));
  return _consume.apply(this, arguments);
}

function main() {
  return _main.apply(this, arguments);
}

function _main() {
  _main = (0, _asyncToGenerator2["default"])(
  /*#__PURE__*/
  _regenerator["default"].mark(function _callee3() {
    var database, pg, votingC, surveyorC, surveyors, _iteratorNormalCompletion, _didIteratorError, _iteratorError, _iterator, _step, surveyor, surveyorId, created, probi, price, _votings, surveyorIds, votings, backfillTransacted;

    return _regenerator["default"].wrap(function _callee3$(_context3) {
      while (1) {
        switch (_context3.prev = _context3.next) {
          case 0:
            database = new Database({
              database: process.env.MONGODB_URI
            }); // process.env.NODE_ENV = 'production'

            pg = new Postgres({
              postgres: {
                url: process.env.DATABASE_URL
              }
            });
            votingC = database.get('voting', debug);
            surveyorC = database.get('surveyors', debug);
            _context3.next = 6;
            return surveyorC.find();

          case 6:
            surveyors = _context3.sent;
            _iteratorNormalCompletion = true;
            _didIteratorError = false;
            _iteratorError = undefined;
            _context3.prev = 10;
            _iterator = surveyors[Symbol.iterator]();

          case 12:
            if (_iteratorNormalCompletion = (_step = _iterator.next()).done) {
              _context3.next = 29;
              break;
            }

            surveyor = _step.value;
            surveyorId = surveyor.surveyorId;
            created = createdTimestamp(surveyor._id);
            probi = surveyor.probi && new BigNumber(surveyor.probi.toString());
            price = probi.dividedBy('1e18').dividedBy(surveyor.votes);
            _context3.next = 20;
            return pg.pool.query('insert into surveyor_groups (id, created_at, updated_at, price, ballots, frozen) values ($1, to_timestamp($2), to_timestamp($3), $4, $5, $6)', [surveyorId, created / 1000, surveyor.timestamp.high_, price.toString(), surveyor.counts, surveyor.frozen || false]);

          case 20:
            console.log('fetching surveyor: ' + surveyorId);
            _context3.next = 23;
            return votingC.find({
              surveyorId: surveyorId
            });

          case 23:
            _votings = _context3.sent;
            _context3.next = 26;
            return consume(pg, _votings);

          case 26:
            _iteratorNormalCompletion = true;
            _context3.next = 12;
            break;

          case 29:
            _context3.next = 35;
            break;

          case 31:
            _context3.prev = 31;
            _context3.t0 = _context3["catch"](10);
            _didIteratorError = true;
            _iteratorError = _context3.t0;

          case 35:
            _context3.prev = 35;
            _context3.prev = 36;

            if (!_iteratorNormalCompletion && _iterator["return"] != null) {
              _iterator["return"]();
            }

          case 38:
            _context3.prev = 38;

            if (!_didIteratorError) {
              _context3.next = 41;
              break;
            }

            throw _iteratorError;

          case 41:
            return _context3.finish(38);

          case 42:
            return _context3.finish(35);

          case 43:
            surveyorIds = surveyors.map(function (surveyor) {
              return surveyor.surveyorId;
            });
            _context3.next = 46;
            return votingC.find({
              'surveyorId': {
                '$nin': surveyorIds
              }
            });

          case 46:
            votings = _context3.sent;
            _context3.next = 49;
            return consume(pg, votings);

          case 49:
            backfillTransacted = "\nupdate votes\n  set transacted = true\nfrom\n(select votes.id\n  from votes join transactions\n  on (transactions.document_id = votes.surveyor_id and transactions.to_account = votes.channel)\n  where not votes.excluded\n) o\nwhere votes.id = o.id\n;\n ";
            _context3.next = 52;
            return pg.pool.query(backfillTransacted, []);

          case 52:
            _context3.next = 54;
            return database.db.close();

          case 54:
          case "end":
            return _context3.stop();
        }
      }
    }, _callee3, null, [[10, 31, 35, 43], [36,, 38, 42]]);
  }));
  return _main.apply(this, arguments);
}

main().then(function (result) {})["catch"](function (e) {
  console.error(e);
});