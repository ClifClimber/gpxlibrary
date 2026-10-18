'use strict';
const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

function countGpxPoints(file) {
  try {
    let c; try { c = fs.readFileSync(file,'utf8'); } catch { c = fs.readFileSync(file,'latin1'); }
    let n=0, pos=0;
    while(true){ const i=c.indexOf('<trkpt',pos); if(i===-1)break; n++; pos=i+6; }
    return n;
  } catch(e){ return 0; }
}

const src     = fs.readFileSync(path.join(ROOT,'catalog-data.js'),'utf8');
const CATALOG = JSON.parse(src.slice(src.indexOf('['), src.lastIndexOf(']')+1));
const catMap  = {};
CATALOG.forEach(t => catMap[t.file] = t.points.length);

const { openDb } = require('./db');
const db = openDb();

const tracks = [
  { id:102, file:'TracksGps/Mtb/Gredos/transgredos-integral-.gpx' },
  { id:284, file:'TracksGps/Trail/Madrid/cercedilla-la-penota-y-pena-del-aguila.gpx' },
  { id:221, file:'TracksGps/Mtb/Sierra Norte/montejo-de-la-sierra-puerto-del-cardoso-collado-del-mosquito.gpx' },
  { id:98,  file:'TracksGps/Mtb/Gredos/circular-a-gredos-occidental.gpx' },
  { id:2,   file:'TracksGps/BikePacking/Camiño Faros Gravel 2 Laxe Muxia.gpx' },
];

const fmt = n => Number(n).toLocaleString('es');
const pct = (a,b) => b ? '-'+(((1-a/b)*100).toFixed(1))+'%' : '—';

console.log('');
console.log('┌──────────────────────────────────────────────────────┬──────────┬──────────┬──────────┬─────────┐');
console.log('│ Track                                                │  GPX     │ DB raw   │ DB clean │ catalog │');
console.log('├──────────────────────────────────────────────────────┼──────────┼──────────┼──────────┼─────────┤');

tracks.forEach(t => {
  const row  = db.prepare('SELECT name,raw_count,clean_count FROM tracks WHERE id=?').get(t.id);
  const gpx  = countGpxPoints(path.join(ROOT, t.file));
  const cat  = catMap[t.file] || 0;
  const raw  = row.raw_count;
  const cln  = row.clean_count;
  const name = row.name.substring(0,52).padEnd(52);
  console.log(`│ ${name} │ ${fmt(gpx).padStart(8)} │ ${fmt(raw).padStart(8)} │ ${fmt(cln).padStart(8)} │ ${String(cat).padStart(7)} │`);
});

console.log('└──────────────────────────────────────────────────────┴──────────┴──────────┴──────────┴─────────┘');
console.log('');
console.log('Reducción por etapa (ejemplo: Transgredos):');
const ex = db.prepare('SELECT raw_count,clean_count FROM tracks WHERE id=102').get();
const cat = catMap['TracksGps/Mtb/Gredos/transgredos-integral-.gpx'];
console.log(`  GPX → DB clean  : ${pct(ex.clean_count, ex.raw_count)} (min-dist 5m + RDP 8m)`);
console.log(`  GPX → catalog   : ${pct(cat, ex.raw_count)} (simplificado a ≤150 pts para el visor)`);
console.log(`  DB clean → cat  : ${pct(cat, ex.clean_count)} (≤150 pts del conjunto ya limpio)`);
console.log('');
console.log('  GPX original  = todos los puntos grabados por el GPS');
console.log('  DB raw        = importados 1:1 a SQLite (=GPX)');
console.log('  DB clean      = tras limpieza (min-dist 5m + RDP 8m)');
console.log('  catalog.js    = simplificado a ≤150 pts para el visor web');
console.log('');
