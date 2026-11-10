'use strict';
// Difficulty scale of the vía ferratas (the French/Spanish one: F, PD, AD, D, TD, ED). For a ferrata the author picks the
// grade (it is stored in tracks.difficulty, 0–5, like any author-chosen grade) and the IBP is not shown: it measures
// distance and ascent, not how vertical or exposed the route is.
window.gpxFerrata = {
  is: act => /ferrata/i.test(act || ''),
  grades: [
    { label: 'F',  name: 'Fácil',               desc: 'Equipada de forma continua y poco expuesta: peldaños, grapas y pasos cortos. Apta para iniciarse.' },
    { label: 'PD', name: 'Poco difícil',        desc: 'Algo más vertical y expuesta, con algún paso atlético, pero muy asegurada.' },
    { label: 'AD', name: 'Algo difícil',        desc: 'Tramos verticales largos y exposición clara. Pide cierta fuerza y práctica.' },
    { label: 'D',  name: 'Difícil',             desc: 'Muy vertical y expuesta, con pasos exigentes y poco descanso. Para gente con experiencia.' },
    { label: 'TD', name: 'Muy difícil',         desc: 'Extraplomos y largos tramos atléticos. Requiere muy buena forma física y técnica.' },
    { label: 'ED', name: 'Extremadamente difícil', desc: 'Máxima dificultad: continuada, extraplomada y con poco equipamiento. Solo para expertos.' },
  ],
  // Same colours as the 6 difficulty levels of the rest of the app, so the badges look alike
  colors: ['#16a34a', '#ca8a04', '#ea580c', '#dc2626', '#9333ea', '#64748b'],
};
