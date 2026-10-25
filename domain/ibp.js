'use strict';
// Local IBP estimate (formulas fitted on real tracks with corrected elevation).
// The official index comes from ibpindex.com (scripts/calc-ibp.js); this is the fallback used at import.
function computeIBP(distKm, gainM) {
  return {
    ibp_hiking:  Math.round(1.664 * distKm + 0.0603 * gainM),
    ibp_bicycle: Math.round(0.162 * distKm + 0.074  * gainM),
    ibp_running: Math.round(2.181 * distKm + 0.148  * gainM),
  };
}

module.exports = { computeIBP };
