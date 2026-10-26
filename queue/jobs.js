'use strict';
// Job types the worker can run. Each one runs an existing script from scripts/ with the arguments
// stored in the job payload ({ args: [...] }), so the scripts keep working from the command line too.
const path = require('path');

const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');

const JOBS = {
  'import-from-temp':  { label: 'Importar GPX' },
  'wikiloc-import':    { label: 'Importar de Wikiloc' },
  'komoot-import':     { label: 'Importar de Komoot' },
  'clean-tracks':      { label: 'Limpiar puntos GPS' },
  'enrich-tracks':     { label: 'Ubicación (Nominatim)' },
  'enrich-road-types': { label: 'Tipos de camino (OSM)' },
  'osm-download':      { label: 'Descargar OSM de España', maxAttempts: 3 },
  'osm-precache':      { label: 'Precaché OSM por zonas', maxAttempts: 3 },
  'calc-ibp':          { label: 'Calcular IBP' },
  'export-folders':    { label: 'Exportar en carpetas' },
  'extract-urls':      { label: 'Extraer URLs' },
  'sync-local':        { label: 'Sincronizar copia local' },
};

// Job types that add new GPX files to S3 — automatically trigger a local sync after success
const IMPORT_TYPES = new Set(['import-from-temp', 'wikiloc-import', 'komoot-import']);

const scriptOf = type => (JOBS[type] ? path.join(SCRIPTS_DIR, `${type}.js`) : null);

// Level of an output line, as the pages colour it
const levelOf = text => (text.startsWith('✗') || text.startsWith('Error') ? 'error' : text.startsWith('⚠') ? 'warn' : 'log');

// Compact summary of a finished run for the operations log (Admin → Logs)
function summarize(lines, code) {
  const all = lines.join('\n');
  const extra = { code };
  const mImp = all.match(/Importados\s*:\s*(\d+)/);
  const mEx  = all.match(/Ya exist[^:]*:\s*(\d+)/);
  const mRev = all.match(/(?:Enviados a _REVIEW_|Por revisar)\s*:\s*(\d+)/);
  const mErr = all.match(/Errores\s*:\s*(\d+)/);
  if (mImp || mEx || mRev || mErr) {
    extra.importados = mImp ? +mImp[1] : 0;
    extra.existian   = mEx  ? +mEx[1]  : 0;
    extra.review     = mRev ? +mRev[1] : 0;
    extra.errores    = mErr ? +mErr[1] : 0;
  }
  const ids = all.match(/IMPORTED_IDS:([\d,]+)/);
  if (ids) extra.ids = ids[1].split(',').map(Number);
  const errorLines = lines.filter(l => l.startsWith('✗') || /^Error/.test(l));
  if (errorLines.length) extra.detalleErrores = errorLines.slice(0, 5);
  const osmApplied = lines.filter(l => /OSM\s*:.*v[ií]as aplicadas/.test(l)).length;
  const osmNoCache = lines.filter(l => /OSM\s*:.*(sin cach|obsoleta)/i.test(l)).length;
  if (osmApplied || osmNoCache) { extra.osm_aplicado = osmApplied; extra.osm_sin_cache = osmNoCache; }
  return extra;
}

module.exports = { JOBS, IMPORT_TYPES, scriptOf, levelOf, summarize };
