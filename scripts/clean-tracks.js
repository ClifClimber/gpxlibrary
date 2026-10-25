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

const { openSql } = require('../repo/sql');

// ── catalog_pts ────────────────────────────────────────────────────
const MAX_CATALOG_PTS = 300;
const { cleanPoints, catalogPts } = require('../domain');

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

(async () => {
const db = openSql();

// ── LIST ──────────────────────────────────────────────────────────
if (opts.list) {
  const rows = await db.all(
    'SELECT id,name,activity,raw_count,clean_count,cleaned,date FROM tracks ORDER BY activity,name'
  );
  console.log(`\n${'ID'.padStart(5)}  ${'Actividad'.padEnd(20)}  ${'Nombre'.padEnd(42)}  ${'Bruto'.padStart(6)}  ${'Limpio'.padStart(7)}  Fecha`);
  console.log('─'.repeat(106));
  for (const r of rows) {
    const c = r.cleaned ? String(r.clean_count).padStart(7) : '      –';
    console.log(`${String(r.id).padStart(5)}  ${(r.activity||'—').padEnd(20)}  ${r.name.substring(0,42).padEnd(42)}  ${String(r.raw_count).padStart(6)}  ${c}  ${r.date||'—'}`);
  }
  console.log(`\n${rows.length} tracks en total.\n`);
  await db.close();
  process.exit(0);
}

// ── STATS ─────────────────────────────────────────────────────────
if (opts.stats) {
  const all = await db.all(
    'SELECT id,name,activity,raw_count,clean_count,cleaned,cleaned_at FROM tracks ORDER BY activity,name'
  );
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
  await db.close();
  process.exit(0);
}

// ── Validar que hay algún algoritmo ───────────────────────────────
if (!opts.reset && !opts.minDist && !opts.maxJump && !opts.rdp) {
  console.error('\nError: indica al menos un algoritmo (--min-dist, --max-jump, --rdp).');
  console.error('Usa --help para ver las opciones.\n');
  process.exit(1);
}

// ── Construir consulta de tracks ──────────────────────────────────
let sql = 'SELECT id,name,activity,raw_count FROM tracks';
const conds=[], params=[];
if(opts.trackId) { conds.push('id=?'); params.push(opts.trackId); }
if(conds.length) sql+=' WHERE '+conds.join(' AND ');
sql+=' ORDER BY activity,name';

const tracks = await db.all(sql, params);
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


let totRaw=0, totCln=0;

for(const track of tracks) {
  const rawPts=await db.getPoints(track.id);

  if(opts.reset){
    if(!opts.dryRun) await db.tx(async t=>{ await t.setPoints(track.id, [], { clean: true }); await t.run('UPDATE tracks SET cleaned=0,clean_count=NULL,cleaned_at=NULL,catalog_pts=? WHERE id=?', [catalogPts(rawPts, MAX_CATALOG_PTS), track.id]); });
    console.log(`  ✓ reset  ${track.name.substring(0,55)} (${rawPts.length} pts)`);
    continue;
  }

  const cleaned=cleanPoints(rawPts, opts);
  const pct=((1-cleaned.length/rawPts.length)*100).toFixed(1);
  totRaw+=rawPts.length; totCln+=cleaned.length;

  console.log(
    `  ${opts.dryRun?'·':'✓'} ${track.name.substring(0,46).padEnd(46)} `+
    `${String(rawPts.length).padStart(5)} → ${String(cleaned.length).padStart(5)} pts  (-${pct}%)`
  );

  if(!opts.dryRun) {
    await db.tx(async t=>{
      await t.setPoints(track.id, cleaned, { clean: true });
      await t.run(`UPDATE tracks SET cleaned=1,clean_count=?,cleaned_at=${t.NOW} WHERE id=?`, [cleaned.length, track.id]);
      const cp = catalogPts(cleaned, MAX_CATALOG_PTS);
      if (cp) await t.run('UPDATE tracks SET catalog_pts=? WHERE id=?', [cp, track.id]);
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
    console.log('\n✓ Listo.\n');
  }
}
await db.close();
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
