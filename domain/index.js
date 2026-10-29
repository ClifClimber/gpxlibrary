'use strict';
// Pure domain logic (no database, no filesystem, no network). See CLAUDE.md → Domain.
module.exports = {
  ...require('./geo'),
  ...require('./gpx-parse'),
  ...require('./metrics'),
  ...require('./classify'),
  ...require('./ibp'),
  ...require('./simplify'),
  ...require('./gpx-export'),
  ...require('./gamification'),
  ...require('./privacy'),
};
