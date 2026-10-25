'use strict';
// Storage for the original GPX files, chosen with STORAGE_DRIVER: local (TracksGps/store) | s3.
// Same async API on both: put (never overwrites), get (null if missing), exists, del, list, ping, close.
// Keys are flat file names: `{uid}.gpx`.
const config = require('../config');
const { createLocalBlob } = require('./local');
const { createS3Blob } = require('./s3');

function createBlob({ driver = config.STORAGE_DRIVER, s3 = config.S3, dir = config.STORE_DIR } = {}) {
  return driver === 's3' ? createS3Blob(s3) : createLocalBlob({ dir });
}

let shared = null;
/** Store for the configured driver, shared within the process. */
function getBlob() { return shared || (shared = createBlob()); }

module.exports = { createBlob, getBlob };
