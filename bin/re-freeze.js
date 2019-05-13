#!/usr/bin/env node
"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

var _regenerator = _interopRequireDefault(require("@babel/runtime/regenerator"));

var _asyncToGenerator2 = _interopRequireDefault(require("@babel/runtime/helpers/asyncToGenerator"));

var Queue = require('bat-utils/lib/runtime-queue');

var SDebug = require('sdebug');

var debug = new SDebug('migrate-transaction-table');

var Postgres = require('bat-utils/lib/runtime-postgres');

function main() {
  return _main.apply(this, arguments);
}

function _main() {
  _main = (0, _asyncToGenerator2["default"])(
  /*#__PURE__*/
  _regenerator["default"].mark(function _callee() {
    var queue, pg, surveyorQ, _iteratorNormalCompletion, _didIteratorError, _iteratorError, _iterator, _step, surveyor, surveyorId;

    return _regenerator["default"].wrap(function _callee$(_context) {
      while (1) {
        switch (_context.prev = _context.next) {
          case 0:
            queue = new Queue({
              queue: process.env.REDIS_URL
            });
            pg = new Postgres({
              postgres: {
                url: process.env.DATABASE_URL
              }
            });
            _context.next = 4;
            return pg.query('select id from surveyor_groups where frozen;', []);

          case 4:
            surveyorQ = _context.sent;

            if (!(surveyorQ.rowCount === 0)) {
              _context.next = 7;
              break;
            }

            throw new Error('surveyors do not exist');

          case 7:
            _iteratorNormalCompletion = true;
            _didIteratorError = false;
            _iteratorError = undefined;
            _context.prev = 10;
            _iterator = surveyorQ.rows[Symbol.iterator]();

          case 12:
            if (_iteratorNormalCompletion = (_step = _iterator.next()).done) {
              _context.next = 21;
              break;
            }

            surveyor = _step.value;
            surveyorId = surveyor.id;

            if (!surveyorId) {
              _context.next = 18;
              break;
            }

            _context.next = 18;
            return queue.send(debug, 'surveyor-frozen-report', {
              surveyorId: surveyorId
            });

          case 18:
            _iteratorNormalCompletion = true;
            _context.next = 12;
            break;

          case 21:
            _context.next = 27;
            break;

          case 23:
            _context.prev = 23;
            _context.t0 = _context["catch"](10);
            _didIteratorError = true;
            _iteratorError = _context.t0;

          case 27:
            _context.prev = 27;
            _context.prev = 28;

            if (!_iteratorNormalCompletion && _iterator["return"] != null) {
              _iterator["return"]();
            }

          case 30:
            _context.prev = 30;

            if (!_didIteratorError) {
              _context.next = 33;
              break;
            }

            throw _iteratorError;

          case 33:
            return _context.finish(30);

          case 34:
            return _context.finish(27);

          case 35:
            _context.next = 37;
            return queue.rsmq.quit();

          case 37:
          case "end":
            return _context.stop();
        }
      }
    }, _callee, null, [[10, 23, 27, 35], [28,, 30, 34]]);
  }));
  return _main.apply(this, arguments);
}

main().then(function (result) {})["catch"](function (e) {
  console.error(e);
});