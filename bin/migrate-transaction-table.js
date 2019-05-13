#!/usr/bin/env node
"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

var _regenerator = _interopRequireDefault(require("@babel/runtime/regenerator"));

var _asyncToGenerator2 = _interopRequireDefault(require("@babel/runtime/helpers/asyncToGenerator"));

var Database = require('bat-utils/lib/runtime-database');

var Queue = require('bat-utils/lib/runtime-queue');

var SDebug = require('sdebug');

var debug = new SDebug('migrate-transaction-table');

function main() {
  return _main.apply(this, arguments);
}

function _main() {
  _main = (0, _asyncToGenerator2["default"])(
  /*#__PURE__*/
  _regenerator["default"].mark(function _callee() {
    var database, queue, settlements, settlementIds, _iteratorNormalCompletion, _didIteratorError, _iteratorError, _iterator, _step, settlementId, referrals, transactionIds, _iteratorNormalCompletion2, _didIteratorError2, _iteratorError2, _iterator2, _step2, transactionId, surveyorsC, surveyors, _iteratorNormalCompletion3, _didIteratorError3, _iteratorError3, _iterator3, _step3, surveyor, surveyorId;

    return _regenerator["default"].wrap(function _callee$(_context) {
      while (1) {
        switch (_context.prev = _context.next) {
          case 0:
            database = new Database({
              database: process.env.MONGODB_URI
            });
            queue = new Queue({
              queue: process.env.REDIS_URL
            }); // settlements

            settlements = database.get('settlements', debug);
            _context.next = 5;
            return settlements.distinct('settlementId');

          case 5:
            settlementIds = _context.sent;
            _iteratorNormalCompletion = true;
            _didIteratorError = false;
            _iteratorError = undefined;
            _context.prev = 9;
            _iterator = settlementIds[Symbol.iterator]();

          case 11:
            if (_iteratorNormalCompletion = (_step = _iterator.next()).done) {
              _context.next = 19;
              break;
            }

            settlementId = _step.value;

            if (!settlementId) {
              _context.next = 16;
              break;
            }

            _context.next = 16;
            return queue.send(debug, 'settlement-report', {
              settlementId: settlementId
            });

          case 16:
            _iteratorNormalCompletion = true;
            _context.next = 11;
            break;

          case 19:
            _context.next = 25;
            break;

          case 21:
            _context.prev = 21;
            _context.t0 = _context["catch"](9);
            _didIteratorError = true;
            _iteratorError = _context.t0;

          case 25:
            _context.prev = 25;
            _context.prev = 26;

            if (!_iteratorNormalCompletion && _iterator["return"] != null) {
              _iterator["return"]();
            }

          case 28:
            _context.prev = 28;

            if (!_didIteratorError) {
              _context.next = 31;
              break;
            }

            throw _iteratorError;

          case 31:
            return _context.finish(28);

          case 32:
            return _context.finish(25);

          case 33:
            // referrals
            referrals = database.get('referrals', debug);
            _context.next = 36;
            return referrals.distinct('transactionId');

          case 36:
            transactionIds = _context.sent;
            _iteratorNormalCompletion2 = true;
            _didIteratorError2 = false;
            _iteratorError2 = undefined;
            _context.prev = 40;
            _iterator2 = transactionIds[Symbol.iterator]();

          case 42:
            if (_iteratorNormalCompletion2 = (_step2 = _iterator2.next()).done) {
              _context.next = 50;
              break;
            }

            transactionId = _step2.value;

            if (!transactionId) {
              _context.next = 47;
              break;
            }

            _context.next = 47;
            return queue.send(debug, 'referral-report', {
              transactionId: transactionId
            });

          case 47:
            _iteratorNormalCompletion2 = true;
            _context.next = 42;
            break;

          case 50:
            _context.next = 56;
            break;

          case 52:
            _context.prev = 52;
            _context.t1 = _context["catch"](40);
            _didIteratorError2 = true;
            _iteratorError2 = _context.t1;

          case 56:
            _context.prev = 56;
            _context.prev = 57;

            if (!_iteratorNormalCompletion2 && _iterator2["return"] != null) {
              _iterator2["return"]();
            }

          case 59:
            _context.prev = 59;

            if (!_didIteratorError2) {
              _context.next = 62;
              break;
            }

            throw _iteratorError2;

          case 62:
            return _context.finish(59);

          case 63:
            return _context.finish(56);

          case 64:
            // contributions
            surveyorsC = database.get('surveyors', debug);
            _context.next = 67;
            return surveyorsC.find({
              surveyorType: 'contribution',
              frozen: true
            });

          case 67:
            surveyors = _context.sent;
            _iteratorNormalCompletion3 = true;
            _didIteratorError3 = false;
            _iteratorError3 = undefined;
            _context.prev = 71;
            _iterator3 = surveyors[Symbol.iterator]();

          case 73:
            if (_iteratorNormalCompletion3 = (_step3 = _iterator3.next()).done) {
              _context.next = 82;
              break;
            }

            surveyor = _step3.value;
            surveyorId = surveyor.surveyorId;

            if (!surveyorId) {
              _context.next = 79;
              break;
            }

            _context.next = 79;
            return queue.send(debug, 'surveyor-frozen-report', {
              surveyorId: surveyorId
            });

          case 79:
            _iteratorNormalCompletion3 = true;
            _context.next = 73;
            break;

          case 82:
            _context.next = 88;
            break;

          case 84:
            _context.prev = 84;
            _context.t2 = _context["catch"](71);
            _didIteratorError3 = true;
            _iteratorError3 = _context.t2;

          case 88:
            _context.prev = 88;
            _context.prev = 89;

            if (!_iteratorNormalCompletion3 && _iterator3["return"] != null) {
              _iterator3["return"]();
            }

          case 91:
            _context.prev = 91;

            if (!_didIteratorError3) {
              _context.next = 94;
              break;
            }

            throw _iteratorError3;

          case 94:
            return _context.finish(91);

          case 95:
            return _context.finish(88);

          case 96:
            _context.next = 98;
            return database.db.close();

          case 98:
            _context.next = 100;
            return queue.rsmq.quit();

          case 100:
          case "end":
            return _context.stop();
        }
      }
    }, _callee, null, [[9, 21, 25, 33], [26,, 28, 32], [40, 52, 56, 64], [57,, 59, 63], [71, 84, 88, 96], [89,, 91, 95]]);
  }));
  return _main.apply(this, arguments);
}

main().then(function (result) {})["catch"](function (e) {
  console.error(e);
});