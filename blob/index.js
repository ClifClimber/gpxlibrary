'use strict';
// Storage for the original GPX files — always S3 (Garage locally, R2/AWS in production).
// API: put (never overwrites), get (null if missing), exists, del, list, ping, close.
// Keys are flat: `{uid}.gpx`.
const config = require('../config');
const { createS3Blob } = require('./s3');

let shared = null;
function getBlob() { return shared || (shared = createS3Blob(config.S3)); }
// For ad-hoc instances (tests, scripts that need a clean connection)
function createBlob({ s3 = config.S3 } = {}) { return createS3Blob(s3); }

module.exports = { createBlob, getBlob };
