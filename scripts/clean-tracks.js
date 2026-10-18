#!/usr/bin/env node
'use strict';

// Limpieza de tracks en la base de datos.
//
// Algoritmos disponibles (se aplican en orden):
//   1. max-jump   — elimina picos GPS (punto aislado muy desviado de sus vecinos)
//   2. min-dist   — elimina puntos demasiado cercanos (GPS estacionario, ruido)
//   3. rdp        — Ramer-Douglas-Peucker: simplifica conservando la forma
//
// Uso:
//   node scripts/clean-tracks.js --help
//   node scripts/clean-tracks.js --stats
//   node scripts/clean-tracks.js --min-dist 5 --rdp 8
//   node scripts/clean-tracks.js --category Mtb --rdp 5 --dry-run
//   node scripts/clean-tracks.js --track-id 42 --rdp 3
//   node scripts/clean-tracks.js --reset              ← deshace la limpieza
//   node scripts/clean-tracks.js --list

const { openDb, withTransaction } = require('./db');

// ── Ayuda ──────────────────────────────────────────────────────────
if (process.argv.includes('--help')) {
  console.log(`
Limpieza de tracks GPX en SQLite

  node scripts/clean-tracks.js [opciones]

Algoritmos:
  --max-jump <m>    Eliminar picos GPS: puntos que se desvían >N metros
                    respecto a la línea prev→next (sugerido: 50–150)
  --min-dist <m>    Eliminar puntos a menos de N metros del anterior
                    (elimina ruido estacionario; sugerido: 5–15)
  --rdp <m>         Douglas-Peucker epsilon en metros.
                    Simplifica la curva quitando puntos redundantes
                    (sugerido: 3–15 para cicloturismo/trail)

Selección:
  --category <cat>  Solo procesar esta categoría
  --track-id <n>    Solo procesar el track con este ID

Modos:
  --dry-run         Muestra resultados sin modificar la BD
  --stats           Tabla de estado de todos los tracks
  --list            Lista tracks con ID, categoría y recuento
  --reset           Borra clean_points y marca cleaned=0

Ejemplos:
  node scripts/clean-tracks.js --stats
  node scripts/clean-tracks.js --min-dist 5 --rdp 10
  node scripts/clean-tracks.js --max-jump 80 --min-dist 8 --rdp 5
  node scripts/clean-tracks.js --category "Mtb" --rdp 5 --dry-run
  node scripts/clean-tracks.js --reset --track-id 42
`);
  process.exit(0);
}

// ── Parsear args ───────────────────────────────────────────────────
function arg(n) { const i=process.argv.indexOf(n); return i!==-1?process.argv[i+1]:null; }
function flag(n) { return process.argv.includes(n); }

const opts = {
  minDist:  parseFloat(arg('--min-dist'))  || 0,
  maxJump:  parseFloat(arg('--max-jump'))  || 0,
  rdp:      parseFloat(arg('--rdp'))       || 0,
  trackId:  parseInt(arg('--track-id'))    || null,
  dryRun:   flag('--dry-run'),
  stats:    flag('--stats'),
  list:     flag('--list'),
  reset:    flag('--reset'),
};

const db = openDb();

// ── LIST ──────────────────────────────────────────────────────────
if (opts.list) {
  const rows = db.prepare(
    'SELECT id,name,activity,raw_count,clean_count,cleaned,date FROM tracks ORDER BY activity,name'
  ).all();
  console.log(`\n${'ID'.padStart(5)}  ${'Actividad'.padEnd(20)}  ${'Nombre'.padEnd(42)}  ${'Bruto'.padStart(6)}  ${'Limpio'.padStart(7)}  Fecha`);
  console.log('─'.repeat(106));
  for (const r of rows) {
    const c = r.cleaned ? String(r.clean_count).padStart(7) : '      –';
    console.log(`${String(r.id).padStart(5)}  ${(r.activity||'—').padEnd(20)}  ${r.name.substring(0,42).padEnd(42)}  ${String(r.raw_count).padStart(6)}  ${c}  ${r.date||'—'}`);
  }
  console.log(`\n${rows.length} tracks en total.\n`);
  process.exit(0);
}

// ── STATS ─────────────────────────────────────────────────────────
if (opts.stats) {
  const all = db.prepare(
    'SELECT id,name,activity,raw_count,clean_count,cleaned,cleaned_at FROM tracks ORDER BY activity,name'
  ).all();
  const cleaned = all.filter(r=>r.cleaned), pending = all.filter(r=>!r.cleaned);
  console.log(`\n━━━ ESTADÍSTICAS DE LIMPIEZA ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Total: ${all.length}  |  Limpios: ${cleaned.length}  |  Sin limpiar: ${pending.length}\n`);
  if (cleaned.length) {
    let tRaw=0, tCln=0;
    console.log(`${'Nombre'.padEnd(44)}  ${'Actividad'.padEnd(12)}  ${'Bruto'.padStart(6)}  ${'Limpio'.padStart(6)}  Reduc%`);
    console.log('─'.repeat(84));
    for (const r of cleaned) {
      const pct = ((1-r.clean_count/r.raw_count)*100).toFixed(1);
      console.log(`${r.name.substring(0,44).padEnd(44)}  ${(r.activity||'—').substring(0,12).padEnd(12)}  ${String(r.raw_count).padStart(6)}  ${String(r.clean_count).padStart(6)}  ${pct.padStart(5)}%`);
      tRaw+=r.raw_count; tCln+=r.clean_count;
    }
    const totPct = ((1-tCln/tRaw)*100).toFixed(1);
    console.log('─'.repeat(84));
    console.log(`${'TOTAL'.padEnd(44)}  ${''.padEnd(12)}  ${String(tRaw).padStart(6)}  ${String(tCln).padStart(6)}  ${totPct.padStart(5)}%`);
  }
  if (pending.length) {
    console.log(`\nSin limpiar (${pending.length}):`);
    const acts = {};
    for (const r of pending) acts[r.activity||'—']=(acts[r.activity||'—']||0)+1;
    for (const [act,n] of Object.entries(acts).sort((a,b)=>b[1]-a[1]))
      console.log(`  ${act.padEnd(25)} ${n}`);
  }
  console.log('');
  process.exit(0);
}

// ── Validar que hay algún algoritmo ───────────────────────────────
if (!opts.reset && !opts.minDist && !opts.maxJump && !opts.rdp) {
  console.error('\nError: indica al menos un algoritmo (--min-dist, --max-jump, --rdp).');
  console.error('Usa --help para ver las opciones.\n');
  process.exit(1);
}

// ── Algoritmos de limpieza ─────────────────────────────────────────

function haversineM(lat1,lon1,lat2,lon2) {
  const R=6371000, D=Math.PI/180;
  const dl=(lat2-lat1)*D, dn=(lon2-lon1)*D;
  const a=Math.sin(dl/2)**2+Math.cos(lat1*D)*Math.cos(lat2*D)*Math.sin(dn/2)**2;
  return R*2*Math.asin(Math.sqrt(a));
}

function perpDistM(p, a, b) {
  const midLat=(a.lat+b.lat)/2, mLat=111132, mLon=111132*Math.cos(midLat*Math.PI/180);
  const bx=(b.lon-a.lon)*mLon, by=(b.lat-a.lat)*mLat;
  const px=(p.lon-a.lon)*mLon, py=(p.lat-a.lat)*mLat;
  const len2=bx*bx+by*by;
  if(len2===0) return Math.hypot(px,py);
  const t=Math.max(0,Math.min(1,(px*bx+py*by)/len2));
  return Math.hypot(px-t*bx, py-t*by);
}

// 1. Picos GPS: punto aislado muy desviado que prev y next se hubieran saltado
function filterMaxJump(pts, maxM) {
  if (!maxM || pts.length<=2) return pts;
  const out=[pts[0]];
  for (let i=1;i<pts.length-1;i++) {
    const prev=out[out.length-1], next=pts[i+1];
    const dPC=haversineM(prev.lat,prev.lon,pts[i].lat,pts[i].lon);
    const dCN=haversineM(pts[i].lat,pts[i].lon,next.lat,next.lon);
    const dPN=haversineM(prev.lat,prev.lon,next.lat,next.lon);
    const spike=dPC>maxM&&dCN>maxM&&dPN<(dPC+dCN)*0.55;
    if(!spike) out.push(pts[i]);
  }
  if(pts.length>1) out.push(pts[pts.length-1]);
  return out;
}

// 2. Puntos muy cercanos (GPS estático, ruido de posición)
function filterMinDist(pts, minM) {
  if (!minM || pts.length<=2) return pts;
  const out=[pts[0]];
  for (let i=1;i<pts.length-1;i++) {
    const prev=out[out.length-1];
    if(haversineM(prev.lat,prev.lon,pts[i].lat,pts[i].lon)>=minM) out.push(pts[i]);
  }
  out.push(pts[pts.length-1]);
  return out;
}

// 3. Ramer-Douglas-Peucker iterativo (sin recursión para no desbordar la pila)
function rdpSimplify(pts, eps) {
  if (!eps || pts.length<=2) return pts;
  const n=pts.length, keep=new Uint8Array(n);
  keep[0]=keep[n-1]=1;
  const stack=[[0,n-1]];
  while(stack.length) {
    const [i,j]=stack.pop();
    if(j-i<2) continue;
    let maxD=0, maxK=i+1;
    for(let k=i+1;k<j;k++){const d=perpDistM(pts[k],pts[i],pts[j]);if(d>maxD){maxD=d;maxK=k;}}
    if(maxD>eps){keep[maxK]=1;stack.push([i,maxK],[maxK,j]);}
  }
  return pts.filter((_,i)=>keep[i]);
}

function clean(pts, o) {
  let out=pts;
  if(o.maxJump>0) out=filterMaxJump(out, o.maxJump);
  if(o.minDist>0) out=filterMinDist(out, o.minDist);
  if(o.rdp>0)     out=rdpSimplify(out, o.rdp);
  return out;
}

// ── Construir consulta de tracks ──────────────────────────────────
let sql = 'SELECT id,name,activity,raw_count FROM tracks';
const conds=[], params=[];
if(opts.trackId) { conds.push('id=?'); params.push(opts.trackId); }
if(conds.length) sql+=' WHERE '+conds.join(' AND ');
sql+=' ORDER BY activity,name';

const tracks = db.prepare(sql).all(...params);
if(!tracks.length){ console.error('\nNo se encontraron tracks con esos criterios.\n'); process.exit(1); }

const label = opts.dryRun ? 'SIMULACIÓN (--dry-run)' : opts.reset ? 'RESET' : 'LIMPIEZA';
console.log(`\n━━━ ${label} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
if(!opts.reset){
  const algos=[];
  if(opts.maxJump) algos.push(`max-jump=${opts.maxJump}m`);
  if(opts.minDist) algos.push(`min-dist=${opts.minDist}m`);
  if(opts.rdp)     algos.push(`rdp=${opts.rdp}m`);
  console.log(`Algoritmos: ${algos.join(', ')}`);
}
console.log(`Tracks a procesar: ${tracks.length}\n`);

// Prepared statements
const fetchRaw   = db.prepare('SELECT lat,lon,ele FROM raw_points   WHERE track_id=? ORDER BY seq');
const delClean   = db.prepare('DELETE FROM clean_points WHERE track_id=?');
const insClean   = db.prepare('INSERT INTO clean_points(track_id,seq,lat,lon,ele) VALUES(?,?,?,?,?)');
const updCleaned = db.prepare("UPDATE tracks SET cleaned=1,clean_count=?,cleaned_at=datetime('now') WHERE id=?");
const updReset   = db.prepare('UPDATE tracks SET cleaned=0,clean_count=NULL,cleaned_at=NULL WHERE id=?');

let totRaw=0, totCln=0;

for(const track of tracks) {
  const rawPts=fetchRaw.all(track.id);

  if(opts.reset){
    if(!opts.dryRun) withTransaction(()=>{ delClean.run(track.id); updReset.run(track.id); });
    console.log(`  ✓ reset  ${track.name.substring(0,55)} (${rawPts.length} pts)`);
    continue;
  }

  const cleaned=clean(rawPts,opts);
  const pct=((1-cleaned.length/rawPts.length)*100).toFixed(1);
  totRaw+=rawPts.length; totCln+=cleaned.length;

  console.log(
    `  ${opts.dryRun?'·':'✓'} ${track.name.substring(0,46).padEnd(46)} `+
    `${String(rawPts.length).padStart(5)} → ${String(cleaned.length).padStart(5)} pts  (-${pct}%)`
  );

  if(!opts.dryRun) {
    withTransaction(()=>{
      delClean.run(track.id);
      for(let i=0;i<cleaned.length;i++){
        const p=cleaned[i];
        insClean.run(track.id,i,p.lat,p.lon,p.ele??null);
      }
      updCleaned.run(cleaned.length, track.id);
    });
  }
}

if(!opts.reset){
  const pctTot=((1-totCln/totRaw)*100).toFixed(1);
  console.log(`\n${'─'.repeat(72)}`);
  console.log(`Total: ${totRaw.toLocaleString()} → ${totCln.toLocaleString()} puntos  (reducción ${pctTot}%)`);
  if(opts.dryRun){
    console.log('\n(Simulación — BD NO modificada)');
    console.log('Quita --dry-run para aplicar la limpieza.\n');
  } else {
    console.log('\n✓ Listo. Regenera el catálogo con:');
    console.log('  node scripts/export-catalog.js\n');
  }
}
