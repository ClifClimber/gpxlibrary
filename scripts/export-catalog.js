#!/usr/bin/env node
'use strict';

// Exporta desde la base de datos SQLite → catalog-data.js
// Usa clean_points si el track fue limpiado, raw_points si no.
// Aplica simplificación uniforme a MAX_POINTS para el visor web.
//
// Uso: node scripts/export-catalog.js [--max-points N]

const fs   = require('fs');
const path = require('path');
const { openDb } = require('./db');

const OUTPUT  = path.join(__dirname, '..', 'catalog-data.js');
const MAX_PTS = parseInt(process.argv[process.argv.indexOf('--max-points')+1]) || 150;

function hav(lat1,lon1,lat2,lon2) {
  const R=6371,D=Math.PI/180;
  const dl=(lat2-lat1)*D, dn=(lon2-lon1)*D;
  const a=Math.sin(dl/2)**2+Math.cos(lat1*D)*Math.cos(lat2*D)*Math.sin(dn/2)**2;
  return R*2*Math.asin(Math.sqrt(a));
}

function simplify(pts, maxN) {
  if(pts.length<=maxN) return pts;
  const out=[], step=(pts.length-1)/(maxN-1);
  for(let i=0;i<maxN;i++) out.push(pts[Math.round(i*step)]);
  return out;
}

function computeStats(pts) {
  let dist=0, gain=0, loss=0, minEle=Infinity, maxEle=-Infinity, hasEle=false;
  let swLat=Infinity, swLon=Infinity, neLat=-Infinity, neLon=-Infinity;
  for(const p of pts){
    if(p.lat<swLat)swLat=p.lat; if(p.lat>neLat)neLat=p.lat;
    if(p.lon<swLon)swLon=p.lon; if(p.lon>neLon)neLon=p.lon;
  }
  for(let i=1;i<pts.length;i++) dist+=hav(pts[i-1].lat,pts[i-1].lon,pts[i].lat,pts[i].lon);
  for(let i=0;i<pts.length;i++){
    const e=pts[i].ele;
    if(e!=null){
      hasEle=true;
      if(e<minEle)minEle=e; if(e>maxEle)maxEle=e;
      if(i>0&&pts[i-1].ele!=null){const d=e-pts[i-1].ele;if(d>0)gain+=d;else loss-=d;}
    }
  }
  return {
    distance:      Math.round(dist*10)/10,
    elevationGain: Math.round(gain),
    elevationLoss: Math.round(loss),
    minElevation:  hasEle?Math.round(minEle):null,
    maxElevation:  hasEle?Math.round(maxEle):null,
    bounds:  [[swLat,swLon],[neLat,neLon]],
    center:  [Math.round((swLat+neLat)/2*10000)/10000, Math.round((swLon+neLon)/2*10000)/10000],
  };
}

const db = openDb();

const tracks = db.prepare(
  "SELECT id,name,file,zone,date,cleaned,color,activity,sierra,province,ccaa,tags FROM tracks ORDER BY date DESC,name ASC"
).all();

if(!tracks.length){
  console.error('\nError: No hay tracks en la BD. Ejecuta: node scripts/import-gpx.js\n');
  process.exit(1);
}

const fetchRaw   = db.prepare('SELECT lat,lon,ele FROM raw_points   WHERE track_id=? ORDER BY seq');
const fetchClean = db.prepare('SELECT lat,lon,ele FROM clean_points WHERE track_id=? ORDER BY seq');

console.log(`\nExportando ${tracks.length} tracks (MAX_POINTS=${MAX_PTS})...`);

let cleanedCount=0;
const catalog=[];

for(const t of tracks){
  const pts=t.cleaned ? fetchClean.all(t.id) : fetchRaw.all(t.id);
  if(pts.length<2) continue;
  if(t.cleaned) cleanedCount++;

  const stats=computeStats(pts);
  const disp=simplify(pts,MAX_PTS);

  catalog.push({
    id:            t.id,
    name:          t.name,
    file:          t.file,
    zone:          t.zone,
    date:          t.date,
    activity:      t.activity||null,
    sierra:        t.sierra||null,
    province:      t.province||null,
    ccaa:          t.ccaa||null,
    tags:          t.tags ? JSON.parse(t.tags) : [],
    distance:      stats.distance,
    elevationGain: stats.elevationGain,
    elevationLoss: stats.elevationLoss,
    minElevation:  stats.minElevation,
    maxElevation:  stats.maxElevation,
    bounds:        stats.bounds,
    center:        stats.center,
    color:         t.color||null,
    points:        disp.map(p=>[
      Math.round(p.lat*100000)/100000,
      Math.round(p.lon*100000)/100000,
      p.ele!=null?Math.round(p.ele):null,
    ]),
  });
}

const js=
  `// Auto-generado por scripts/export-catalog.js\n`+
  `// ${catalog.length} tracks · ${new Date().toISOString()}\n`+
  `// ${cleanedCount} limpios · ${catalog.length-cleanedCount} sin limpiar\n`+
  `const CATALOG = ${JSON.stringify(catalog)};\n`;

fs.writeFileSync(OUTPUT, js, 'utf8');

const kb=Math.round(Buffer.byteLength(js)/1024);
console.log(`\n✓ catalog-data.js generado:`);
console.log(`  Tracks     : ${catalog.length}`);
console.log(`  Limpios    : ${cleanedCount}`);
console.log(`  Sin limpiar: ${catalog.length-cleanedCount}`);
console.log(`  Tamaño     : ${kb} KB`);

const acts={};
for(const t of catalog) acts[t.activity||'Sin actividad']=(acts[t.activity||'Sin actividad']||0)+1;
console.log('\nActividades:');
for(const [act,n] of Object.entries(acts).sort((a,b)=>b[1]-a[1]))
  console.log(`  ${act.padEnd(30)} ${n}`);
console.log('');
