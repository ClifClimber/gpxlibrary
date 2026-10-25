'use strict';
// Data-access entry point. The rest of the app uses getRepo() and never talks SQL directly,
// so the engine can be switched with DB_DRIVER=sqlite|postgres in .env.
const config = require('../config');

let _repo = null;

function createRepo({ driver = config.DB_DRIVER, connectionString = config.DATABASE_URL } = {}) {
  if (driver === 'postgres') {
    if (!connectionString) throw new Error('DB_DRIVER=postgres necesita DATABASE_URL en .env');
    return require('./postgres').createPostgresRepo({ connectionString });
  }
  return require('./sqlite').createSqliteRepo();
}

function getRepo() {
  if (!_repo) _repo = createRepo();
  return _repo;
}

module.exports = { getRepo, createRepo };
