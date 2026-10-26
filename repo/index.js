'use strict';
// Data-access entry point. Always PostgreSQL — use DATABASE_URL in .env.
const config = require('../config');

let _repo = null;

function createRepo({ connectionString = config.DATABASE_URL } = {}) {
  if (!connectionString) throw new Error('DATABASE_URL no configurado en .env');
  return require('./postgres').createPostgresRepo({ connectionString });
}

function getRepo() {
  if (!_repo) _repo = createRepo();
  return _repo;
}

module.exports = { getRepo, createRepo };
