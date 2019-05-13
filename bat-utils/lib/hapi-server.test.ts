'use strict';

var __importDefault = this && this.__importDefault || function (mod) {
  return mod && mod.__esModule ? mod : {
    "default": mod
  };
};

Object.defineProperty(exports, "__esModule", {
  value: true
});

const hapi_server_1 = __importDefault(require("./hapi-server"));

const runtime_cache_1 = __importDefault(require("./runtime-cache"));

const ava_1 = __importDefault(require("ava"));

const dotenv_1 = __importDefault(require("dotenv"));

const supertest_1 = __importDefault(require("supertest"));

dotenv_1.default.config();
ava_1.default('hapi throws', async t => {
  const message = 'failed in throwing test';
  const runtime = {
    config: {
      server: {}
    },
    notify: () => {},
    captureException: (err, extra) => {
      t.is(err.message, message);
    },
    cache: new runtime_cache_1.default({
      cache: {
        redis: {
          url: process.env.BAT_REDIS_URL || 'redis://localhost:6379'
        }
      }
    }, {})
  };
  const server = await hapi_server_1.default({
    id: 'a',
    routes: {
      routes: async () => {
        return {
          method: 'GET',
          path: '/throwing-test',
          handler: async (request, reply) => {
            throw new Error(message);
          }
        };
      }
    }
  }, runtime);
  await server.started;
  await supertest_1.default(server.listener).get('/throwing-test').send().expect(500);
  await server.stop({
    timeout: 1
  });
});