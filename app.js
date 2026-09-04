/* =====================================================================
   DIARIO DE ENTRENOS
   Firebase Auth + Firestore. Cada usuario ve solo sus datos:
   usuarios/{uid}                  -> perfil (fcMax, objetivos, metas, PRs a mano)
   usuarios/{uid}/running/{id}     -> entrenos de carrera
   usuarios/{uid}/fuerza/{id}      -> ejercicios de fuerza
   usuarios/{uid}/semanas/{id}     -> check-ins semanales
   ===================================================================== */

const firebaseConfig = {
  apiKey: "AIzaSyCgc30vceOoy8_vJAFG2nqXwgsRHIHX6t4",
  authDomain: "app-web-runn.firebaseapp.com",
  projectId: "app-web-runn",
  storageBucket: "app-web-runn.firebasestorage.app",
  messagingSenderId: "25514057738",
  appId: "1:25514057738:web:00ab727c442f4ea98dbff3"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

const PERFIL_DEFECTO = {
  nombre: '', fcMax: null, edad: null, objetivoKm: 40, objetivoSesiones: 5,
  metas: [], prsManual: {}
};

let usuario = null;
let datos = { running: [], fuerza: [], semanas: [], perfil: { ...PERFIL_DEFECTO } };
let ejercicioActivo = null;
let filtroHistorial = 'todos';
let pendientes = [];
let modoRegistro = false;

/* ------------------------------------------------------------------ */
/* 1) UTILIDADES                                                       */
/* ------------------------------------------------------------------ */
// Fechas siempre en hora LOCAL. toISOString() convierte a UTC y en España
// (UTC+1/+2) desplaza el día una jornada hacia atrás: por eso «hoy» salía
// marcado en el día siguiente.
const isoLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const desdeISO = iso => {
  const [a, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(a, (m || 1) - 1, d || 1);
};
const hoyISO = () => isoLocal(new Date());
const cargando = a => { $('#loading-overlay').hidden = !a; };
const generarId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const num = (v, d = 1) => Number(v).toLocaleString('es-ES', { maximumFractionDigits: d });

function fechaCorta(iso) { const [a, m, d] = iso.split('-'); return `${d}/${m}`; }
function fechaLarga(iso) { const [a, m, d] = iso.split('-'); return `${d}/${m}/${a}`; }
function ritmo(km, min) { return km > 0 ? min / km : 0; }
function fmtRitmo(v) {
  if (!v || !isFinite(v)) return '—';
  const m = Math.floor(v), s = Math.round((v - m) * 60);
  return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtHoras(min) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}
function fmtTiempo(min) {
  const total = Math.round(min * 60);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}
function lunesDe(fecha) {
  const d = fecha instanceof Date ? new Date(fecha) : desdeISO(fecha);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}
function claveSemana(fecha) { return isoLocal(lunesDe(fecha)); }
function etiquetaSemana(iso) {
  const d = desdeISO(iso);
  return `${d.getDate()} ${d.toLocaleDateString('es-ES', { month: 'short' }).replace('.', '')}`;
}
function escapar(t) {
  return String(t ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------------ */
/* 2) CAPA DE DATOS (siempre bajo el uid del usuario)                  */
/* ------------------------------------------------------------------ */
const refUsuario = () => db.collection('usuarios').doc(usuario.uid);
const col = nombre => refUsuario().collection(nombre);

async function cargarTodo() {
  const [run, fue, sem, perfilSnap] = await Promise.all([
    col('running').get(), col('fuerza').get(), col('semanas').get(), refUsuario().get()
  ]);
  const mapear = s => s.docs.map(d => ({ id: d.id, ...d.data() }));
  datos.running = mapear(run).sort((a, b) => a.fecha.localeCompare(b.fecha));
  datos.fuerza = mapear(fue).sort((a, b) => a.fecha.localeCompare(b.fecha));
  datos.semanas = mapear(sem).sort((a, b) => a.fecha.localeCompare(b.fecha));
  datos.perfil = { ...PERFIL_DEFECTO, ...(perfilSnap.exists ? perfilSnap.data() : {}) };
}

async function guardar(nombre, doc) {
  const { id, ...resto } = doc;
  await col(nombre).doc(id).set(resto);
}
async function borrar(nombre, id) { await col(nombre).doc(id).delete(); }
async function guardarPerfil(campos) {
  datos.perfil = { ...datos.perfil, ...campos };
  await refUsuario().set(campos, { merge: true });
}

/* ------------------------------------------------------------------ */
/* 3) AUTENTICACIÓN                                                    */
/* ------------------------------------------------------------------ */
const mensajesError = {
  'auth/invalid-email': 'Ese correo no tiene un formato válido.',
  'auth/user-not-found': 'No hay ninguna cuenta con ese correo.',
  'auth/wrong-password': 'Contraseña incorrecta.',
  'auth/invalid-credential': 'Correo o contraseña incorrectos.',
  'auth/email-already-in-use': 'Ya existe una cuenta con ese correo. Prueba a entrar.',
  'auth/weak-password': 'La contraseña necesita al menos 6 caracteres.',
  'auth/popup-closed-by-user': 'Has cerrado la ventana de Google antes de terminar.',
  'auth/popup-blocked': 'El navegador ha bloqueado la ventana de Google.',
  'auth/operation-not-allowed': 'Ese método de acceso no está activado en Firebase.',
  'auth/unauthorized-domain': 'Este dominio no está autorizado en Firebase Authentication.',
  'auth/network-request-failed': 'Sin conexión con Firebase.'
};

function mostrarErrorAuth(err) {
  const el = $('#auth-error');
  el.textContent = mensajesError[err.code] || err.message;
  el.hidden = false;
}

$('#btn-google').addEventListener('click', async () => {
  $('#auth-error').hidden = true;
  try {
    await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
  } catch (err) { mostrarErrorAuth(err); }
});

$('#btn-auth-modo').addEventListener('click', () => {
  modoRegistro = !modoRegistro;
  $('#btn-auth-submit').textContent = modoRegistro ? 'Crear cuenta' : 'Entrar';
  $('#auth-toggle-texto').textContent = modoRegistro ? '¿Ya tienes cuenta?' : '¿No tienes cuenta?';
  $('#btn-auth-modo').textContent = modoRegistro ? 'Entrar' : 'Crear una';
  $('#auth-error').hidden = true;
});

$('#form-auth').addEventListener('submit', async e => {
  e.preventDefault();
  $('#auth-error').hidden = true;
  const { email, password } = Object.fromEntries(new FormData(e.target).entries());
  cargando(true);
  try {
    if (modoRegistro) await auth.createUserWithEmailAndPassword(email, password);
    else await auth.signInWithEmailAndPassword(email, password);
  } catch (err) { mostrarErrorAuth(err); }
  finally { cargando(false); }
});

$('#btn-reset').addEventListener('click', async () => {
  const email = $('#form-auth [name=email]').value.trim();
  if (!email) { $('#auth-error').textContent = 'Escribe tu correo arriba y vuelve a pulsar.'; $('#auth-error').hidden = false; return; }
  try {
    await auth.sendPasswordResetEmail(email);
    $('#auth-error').textContent = `Te hemos enviado un correo a ${email} para cambiar la contraseña.`;
    $('#auth-error').hidden = false;
  } catch (err) { mostrarErrorAuth(err); }
});

$('#btn-salir').addEventListener('click', () => auth.signOut());

auth.onAuthStateChanged(async user => {
  usuario = user;
  if (!user) {
    $('#app').hidden = true;
    $('#auth-gate').hidden = false;
    cargando(false);
    return;
  }
  $('#auth-gate').hidden = true;
  $('#app').hidden = false;
  cargando(true);
  try {
    await cargarTodo();
    if (!datos.perfil.nombre) {
      const nombre = user.displayName || (user.email || '').split('@')[0];
      await guardarPerfil({ nombre });
    }
    pintarUsuario();
    await comprobarDatosAntiguos();
    renderizar();
  } catch (err) {
    console.error(err);
    alert('No se han podido cargar tus datos. Comprueba tu conexión y las reglas de Firestore.');
  } finally { cargando(false); }
});

function pintarUsuario() {
  const nombre = datos.perfil.nombre || 'Cuenta';
  const inicial = nombre.slice(0, 1).toUpperCase();
  $('#usuario-nombre').textContent = nombre;
  $('#usuario-inicial').textContent = inicial;
  $('#cuenta-inicial').textContent = inicial;
  $('#cuenta-nombre').textContent = nombre;
  $('#cuenta-email').textContent = usuario.email || 'Cuenta de Google';
  const f = $('#form-perfil');
  f.nombre.value = datos.perfil.nombre || '';
  f.fcMax.value = datos.perfil.fcMax ?? '';
  f.edad.value = datos.perfil.edad ?? '';
  f.objetivoKm.value = datos.perfil.objetivoKm ?? '';
  f.objetivoSesiones.value = datos.perfil.objetivoSesiones ?? '';
}

/* Datos que quedaron en las colecciones antiguas (sin usuario) */
async function comprobarDatosAntiguos() {
  try {
    const [r, f, s] = await Promise.all([
      db.collection('running').limit(1).get(),
      db.collection('fuerza').limit(1).get(),
      db.collection('semanas').limit(1).get()
    ]);
    if (r.empty && f.empty && s.empty) return;
    $('#btn-migrar').hidden = false;
  } catch (_) { /* las reglas nuevas pueden bloquear la lectura: es correcto */ }
}

$('#btn-migrar').addEventListener('click', async () => {
  if (!confirm('Se copiarán a tu cuenta los entrenos que estaban guardados sin usuario. ¿Seguimos?')) return;
  cargando(true);
  try {
    let total = 0;
    for (const nombre of ['running', 'fuerza', 'semanas']) {
      const snap = await db.collection(nombre).get();
      if (snap.empty) continue;
      const lote = db.batch();
      snap.docs.forEach(d => { lote.set(col(nombre).doc(d.id), d.data()); total++; });
      await lote.commit();
    }
    await cargarTodo();
    renderizar();
    alert(`Listo: ${total} registros copiados a tu cuenta.`);
  } catch (err) {
    console.error(err);
    alert('No se han podido copiar. Puede que las reglas de Firestore ya bloqueen las colecciones antiguas.');
  } finally { cargando(false); }
});

/* ------------------------------------------------------------------ */
/* 4) NAVEGACIÓN                                                       */
/* ------------------------------------------------------------------ */
function irA(tab) {
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === tab));
  window.scrollTo(0, 0);
}
$$('.tab-btn').forEach(b => b.addEventListener('click', () => irA(b.dataset.tab)));
$('#btn-chip-usuario').addEventListener('click', () => irA('cuenta'));

/* ------------------------------------------------------------------ */
/* 5) CÁLCULOS                                                         */
/* ------------------------------------------------------------------ */
function fcMaxima() {
  if (datos.perfil.fcMax) return datos.perfil.fcMax;
  if (datos.perfil.edad) return 220 - datos.perfil.edad;
  const medida = Math.max(0, ...datos.running.map(e => e.fcMaxima || 0));
  return medida || null;
}

function kmPorSemana() {
  const mapa = new Map();
  datos.running.forEach(e => {
    const k = claveSemana(e.fecha);
    const v = mapa.get(k) || { km: 0, min: 0, sesiones: 0 };
    v.km += e.distancia; v.min += e.duracion; v.sesiones++;
    mapa.set(k, v);
  });
  return [...mapa.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([iso, v]) => ({ iso, ...v, ritmo: ritmo(v.km, v.min) }));
}

function rachaSemanas() {
  const objetivo = datos.perfil.objetivoKm || 0;
  if (!objetivo) return 0;
  const mapa = new Map(kmPorSemana().map(s => [s.iso, s.km]));
  let cuenta = 0;
  const cursor = lunesDe(new Date());
  // la semana en curso solo cuenta si ya se ha cumplido
  if ((mapa.get(isoLocal(cursor)) || 0) >= objetivo) cuenta++;
  cursor.setDate(cursor.getDate() - 7);
  while ((mapa.get(isoLocal(cursor)) || 0) >= objetivo) {
    cuenta++;
    cursor.setDate(cursor.getDate() - 7);
  }
  return cuenta;
}

function semanaActual() {
  const inicio = isoLocal(lunesDe(new Date()));
  const runs = datos.running.filter(e => claveSemana(e.fecha) === inicio);
  const fue = datos.fuerza.filter(e => claveSemana(e.fecha) === inicio);
  const sesionesFuerza = new Set(fue.map(e => e.fecha)).size;
  return {
    inicio,
    km: runs.reduce((s, e) => s + e.distancia, 0),
    sesiones: runs.length + sesionesFuerza,
    sesionesRunning: runs.length,
    sesionesFuerza,
    fechas: new Set([...runs.map(e => e.fecha), ...fue.map(e => e.fecha)])
  };
}

const DISTANCIAS_PR = [
  { clave: '1k', d: 1, label: '1 km' },
  { clave: '5k', d: 5, label: '5 km' },
  { clave: '10k', d: 10, label: '10 km' },
  { clave: '21k', d: 21.0975, label: 'Media maratón' },
  { clave: '42k', d: 42.195, label: 'Maratón' }
];

function calcularRecords() {
  return DISTANCIAS_PR.map(({ clave, d, label }) => {
    let mejor = null;
    datos.running.forEach(e => {
      if (!e.distancia || !e.duracion || e.distancia < d * 0.98) return;
      const exacto = e.distancia <= d * 1.02;
      const tiempo = e.duracion * (d / e.distancia);
      // si el entreno fue mucho más largo, el ritmo medio subestima el récord real
      if (!exacto && e.distancia > d * 1.6) return;
      if (!mejor || tiempo < mejor.tiempo) mejor = { tiempo, fecha: e.fecha, exacto };
    });
    const manual = datos.perfil.prsManual?.[clave];
    if (manual && (!mejor || manual.tiempo < mejor.tiempo)) {
      mejor = { tiempo: manual.tiempo, fecha: manual.fecha, exacto: true, manual: true };
    }
    return { clave, label, d, ...(mejor || {}) };
  }).filter(r => r.tiempo || r.d <= 21.0975);
}

function zonasFC() {
  const max = fcMaxima();
  const def = [
    { nombre: 'Z1 Recuperación', min: 0, max: .6, color: '#5c7cff' },
    { nombre: 'Z2 Aeróbico', min: .6, max: .7, color: '#b6ff2e' },
    { nombre: 'Z3 Tempo', min: .7, max: .8, color: '#ffcd50' },
    { nombre: 'Z4 Umbral', min: .8, max: .9, color: '#ff7a1a' },
    { nombre: 'Z5 VO2máx', min: .9, max: 1.4, color: '#ff5c5c' }
  ];
  if (!max) return { max: null, total: 0, lista: def.map(z => ({ ...z, minutos: 0, pct: 0 })) };

  const desde = new Date(); desde.setHours(0, 0, 0, 0); desde.setDate(desde.getDate() - 30);
  const conFC = datos.running.filter(e => e.fcMedia && desdeISO(e.fecha) >= desde);
  const lista = def.map(z => ({ ...z, minutos: 0 }));
  conFC.forEach(e => {
    const r = e.fcMedia / max;
    const i = lista.findIndex(z => r >= z.min && r < z.max);
    if (i >= 0) lista[i].minutos += e.duracion;
  });
  const total = lista.reduce((s, z) => s + z.minutos, 0);
  return {
    max, total, entrenos: conFC.length,
    lista: lista.map(z => ({
      ...z,
      pct: total ? (z.minutos / total) * 100 : 0,
      rango: z.min === 0
        ? `< ${Math.round(z.max * max)} ppm`
        : z.max > 1
          ? `${Math.round(z.min * max)} + ppm`
          : `${Math.round(z.min * max)} - ${Math.round(z.max * max)}`
    }))
  };
}

function sesionesFuerza() {
  const mapa = new Map();
  datos.fuerza.forEach(e => {
    const v = mapa.get(e.fecha) || { fecha: e.fecha, volumen: 0, ejercicios: 0 };
    v.volumen += (e.series || 0) * (e.reps || 0) * (e.peso || 0);
    v.ejercicios++;
    mapa.set(e.fecha, v);
  });
  return [...mapa.values()].sort((a, b) => a.fecha.localeCompare(b.fecha));
}

const oneRM = (peso, reps) => peso * (1 + reps / 30); // Epley

/* ------------------------------------------------------------------ */
/* 6) GRÁFICAS SVG                                                     */
/* ------------------------------------------------------------------ */
function svgEl(tipo, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tipo);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
function limpiar(svg) { while (svg.firstChild) svg.removeChild(svg.firstChild); }
function sinDatos(svg, texto, w, h) {
  const t = svgEl('text', { x: w / 2, y: h / 2, 'text-anchor': 'middle', class: 'sin-datos' });
  t.textContent = texto;
  svg.appendChild(t);
}

/* Barras (km/semana) + línea (ritmo medio) + línea de objetivo */
function graficaCombo() {
  const svg = $('#chart-combo');
  limpiar(svg);
  const semanas = kmPorSemana().slice(-8);
  if (!semanas.length) return sinDatos(svg, 'Registra tu primer entreno para ver la evolución', 620, 280);

  const L = 52, R = 552, T = 24, B = 244, W = R - L, H = B - T;
  const objetivo = datos.perfil.objetivoKm || 0;
  const maxKm = Math.max(objetivo, ...semanas.map(s => s.km)) * 1.14;
  const paso = W / semanas.length;
  const bw = Math.min(46, paso * 0.52);

  // escala del ritmo: se calcula antes de las barras para poder esquivar
  // las etiquetas que caigan justo encima de un punto de la línea
  const rs = semanas.map(s => s.ritmo).filter(Boolean);
  const rMin = rs.length ? Math.min(...rs) - .16 : 0;
  const rMax = rs.length ? Math.max(...rs) + .16 : 1;
  const px = i => L + i * paso + paso / 2;
  const py = v => T + 14 + (1 - (v - rMin) / (rMax - rMin)) * (H - 46);
  const ritmoY = semanas.map(s => (s.ritmo ? py(s.ritmo) : null));

  [0, .25, .5, .75].forEach(t => {
    const y = B - t * H;
    svg.appendChild(svgEl('line', { x1: L, y1: y, x2: R, y2: y, class: 'grid-line' }));
    const et = svgEl('text', { x: L - 8, y: y + 3.5, 'text-anchor': 'end', class: 'grid-label eje-km' });
    et.textContent = `${Math.round(t * maxKm)}`;
    svg.appendChild(et);
  });

  // rótulos de los dos ejes
  const tituloKm = svgEl('text', { x: L - 8, y: T - 8, 'text-anchor': 'end', class: 'eje-titulo eje-km' });
  tituloKm.textContent = 'KM';
  svg.appendChild(tituloKm);

  // eje derecho: ritmo min/km (más arriba = más rápido)
  if (rs.length) {
    const tituloR = svgEl('text', { x: R + 8, y: T - 8, class: 'eje-titulo eje-ritmo' });
    tituloR.textContent = 'MIN/KM';
    svg.appendChild(tituloR);
    [0, .34, .67, 1].forEach(t => {
      const v = rMin + t * (rMax - rMin);
      const y = py(v);
      svg.appendChild(svgEl('line', { x1: R, y1: y, x2: R + 5, y2: y, class: 'grid-line' }));
      const et = svgEl('text', { x: R + 9, y: y + 3.5, class: 'grid-label eje-ritmo' });
      et.textContent = fmtRitmo(v);
      svg.appendChild(et);
    });
  }

  semanas.forEach((s, i) => {
    const h = Math.max((s.km / maxKm) * H, 2);
    const x = L + i * paso + (paso - bw) / 2;
    svg.appendChild(svgEl('rect', { x, y: B - h, width: bw, height: h, rx: 4, class: 'barra' }));
    const cx = x + bw / 2;
    // dentro de la barra si hay sitio; si no, encima
    let ly = h >= 30 ? B - h + 15 : B - h - 7;
    if (ritmoY[i] !== null && Math.abs(ly - ritmoY[i]) < 14) ly = ritmoY[i] + (ly > ritmoY[i] ? 16 : -16);
    const v = svgEl('text', { x: cx, y: ly, 'text-anchor': 'middle', class: 'valor-barra' });
    v.textContent = num(s.km);
    svg.appendChild(v);
    const et = svgEl('text', { x: cx, y: 268, 'text-anchor': 'middle', class: 'etiqueta' });
    et.textContent = etiquetaSemana(s.iso);
    svg.appendChild(et);
  });

  if (objetivo) {
    const y = B - (objetivo / maxKm) * H;
    svg.appendChild(svgEl('path', { d: `M ${L} ${y} L ${R} ${y}`, class: 'objetivo' }));
    const et = svgEl('text', { x: L + 4, y: y - 7, class: 'etiqueta-objetivo' });
    et.textContent = `OBJETIVO ${objetivo} KM`;
    svg.appendChild(et);
  }

  const conRitmo = semanas.filter(s => s.ritmo > 0);
  if (conRitmo.length >= 2) {
    const coords = semanas.map((s, i) => (s.ritmo ? [px(i), ritmoY[i]] : null)).filter(Boolean);
    const d = 'M ' + coords.map(c => `${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(' L ');
    svg.appendChild(svgEl('path', { d: `${d} L ${coords[coords.length - 1][0]},${B} L ${coords[0][0]},${B} Z`, class: 'area' }));
    svg.appendChild(svgEl('path', { d, class: 'linea' }));
    coords.forEach(c => svg.appendChild(svgEl('circle', { cx: c[0], cy: c[1], r: 4, class: 'punto' })));

    const [ux, uy] = coords[coords.length - 1];
    svg.appendChild(svgEl('rect', { x: ux - 80, y: uy - 30, width: 76, height: 22, rx: 11, class: 'tag-fondo' }));
    const t = svgEl('text', { x: ux - 42, y: uy - 14.5, 'text-anchor': 'middle', class: 'tag-texto' });
    t.textContent = `${fmtRitmo(conRitmo[conRitmo.length - 1].ritmo)} /km`;
    svg.appendChild(t);
  }
}

function graficaVolumen() {
  const svg = $('#chart-volumen');
  limpiar(svg);
  const sesiones = sesionesFuerza().slice(-8);
  if (!sesiones.length) return sinDatos(svg, 'Sin sesiones de fuerza todavía', 560, 220);

  const max = Math.max(...sesiones.map(s => s.volumen)) * 1.18 || 1;
  const paso = 540 / sesiones.length, bw = Math.min(38, paso * .55);
  svg.appendChild(svgEl('line', { x1: 10, y1: 188, x2: 550, y2: 188, class: 'grid-line' }));

  sesiones.forEach((s, i) => {
    const h = Math.max((s.volumen / max) * 150, 2);
    const x = 12 + i * paso + (paso - bw) / 2;
    svg.appendChild(svgEl('rect', {
      x, y: 188 - h, width: bw, height: h, rx: 4,
      class: 'barra-vol' + (i === sesiones.length - 1 ? ' ultima' : '')
    }));
    const cx = x + bw / 2;
    const v = svgEl('text', { x: cx, y: 188 - h - 7, 'text-anchor': 'middle', class: 'valor-vol' });
    v.textContent = s.volumen >= 1000 ? `${(s.volumen / 1000).toFixed(1)}t` : Math.round(s.volumen);
    svg.appendChild(v);
    const et = svgEl('text', { x: cx, y: 212, 'text-anchor': 'middle', class: 'etiqueta' });
    et.textContent = fechaCorta(s.fecha);
    svg.appendChild(et);
  });
}

function graficaEjercicio() {
  const svg = $('#chart-ejercicio');
  limpiar(svg);
  if (!ejercicioActivo) return sinDatos(svg, 'Guarda una sesión de fuerza para ver la progresión', 620, 250);

  // mejor serie de cada día para el ejercicio elegido
  const mapa = new Map();
  datos.fuerza.filter(e => e.ejercicio === ejercicioActivo).forEach(e => {
    const prev = mapa.get(e.fecha);
    if (!prev || e.peso > prev.peso) mapa.set(e.fecha, e);
  });
  const serie = [...mapa.values()].sort((a, b) => a.fecha.localeCompare(b.fecha)).slice(-10);
  if (!serie.length) return sinDatos(svg, 'Sin datos de este ejercicio', 620, 250);

  $('#nota-progresion').textContent =
    `Peso levantado y 1RM estimado (Epley) — ${ejercicioActivo}`;

  const L = 44, R = 600, T = 20, B = 218;
  const pesos = serie.map(e => e.peso);
  const rms = serie.map(e => oneRM(e.peso, e.reps));
  const max = Math.max(...rms) * 1.08 || 1;
  const min = Math.max(0, Math.min(...pesos) - Math.max(...pesos) * .3);
  const px = i => serie.length === 1 ? (L + R) / 2 : L + (i / (serie.length - 1)) * (R - L);
  const py = v => T + (1 - (v - min) / (max - min)) * (B - T);

  [0, .33, .66, 1].forEach(t => {
    const y = B - t * (B - T);
    svg.appendChild(svgEl('line', { x1: L, y1: y, x2: R, y2: y, class: 'grid-line' }));
    const et = svgEl('text', { x: L - 6, y: y + 3.5, 'text-anchor': 'end', class: 'grid-label' });
    et.textContent = `${Math.round(min + t * (max - min))}kg`;
    svg.appendChild(et);
  });

  if (serie.length > 1) {
    svg.appendChild(svgEl('path', {
      d: 'M ' + rms.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' L '),
      class: 'rm'
    }));
    const d = 'M ' + pesos.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' L ');
    svg.appendChild(svgEl('path', { d: `${d} L ${px(serie.length - 1)},${B} L ${px(0)},${B} Z`, class: 'area' }));
    svg.appendChild(svgEl('path', { d, class: 'linea' }));
  }
  serie.forEach((e, i) => {
    svg.appendChild(svgEl('circle', { cx: px(i), cy: py(e.peso), r: 4, class: 'punto' }));
    const et = svgEl('text', { x: px(i), y: 242, 'text-anchor': 'middle', class: 'etiqueta' });
    et.textContent = fechaCorta(e.fecha);
    svg.appendChild(et);
  });
}

/* ------------------------------------------------------------------ */
/* 7) RENDER                                                           */
/* ------------------------------------------------------------------ */
function renderizar() {
  renderResumen();
  renderRecords();
  renderListaRunning();
  renderFuerza();
  renderSemana();
  renderHistorial();
  graficaCombo();
  graficaVolumen();
  graficaEjercicio();
}

function renderResumen() {
  const sem = semanaActual();
  const objetivoKm = datos.perfil.objetivoKm || 0;
  const objetivoSes = datos.perfil.objetivoSesiones || 0;

  const racha = rachaSemanas();
  $('#racha-semanas').textContent = racha;
  $('#racha-texto').textContent = objetivoKm
    ? (racha === 1 ? 'semana cumpliendo objetivo' : 'semanas cumpliendo objetivo')
    : 'pon un objetivo semanal en Cuenta';

  const nombres = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
  const lunes = lunesDe(new Date());
  // índice de hoy dentro de la semana: 0 = lunes … 6 = domingo.
  // Se calcula del día de la semana directamente, sin pasar por fechas.
  const indiceHoy = (new Date().getDay() + 6) % 7;
  $('#semana-dias').innerHTML = nombres.map((n, i) => {
    const d = new Date(lunes); d.setDate(lunes.getDate() + i);
    const iso = isoLocal(d);
    return `<div class="dia ${sem.fechas.has(iso) ? 'on' : ''} ${i === indiceHoy ? 'hoy' : ''}" title="${fechaLarga(iso)}">
      <div class="dia-barra"></div><span>${n}</span></div>`;
  }).join('');

  const pctKm = objetivoKm ? Math.min(100, (sem.km / objetivoKm) * 100) : 0;
  $('#objetivos-resumen').textContent = objetivoKm ? `${Math.round(pctKm)}% completado` : '';
  $('#objetivos-lista').innerHTML = [
    { nombre: 'Kilómetros', valor: `${num(sem.km)} / ${objetivoKm || '—'} km`, pct: pctKm, color: 'linear-gradient(90deg,#ff7a1a,#b6ff2e)' },
    { nombre: 'Sesiones', valor: `${sem.sesiones} / ${objetivoSes || '—'}`, pct: objetivoSes ? Math.min(100, (sem.sesiones / objetivoSes) * 100) : 0, color: '#ff7a1a' },
    { nombre: 'Fuerza', valor: `${sem.sesionesFuerza} ${sem.sesionesFuerza === 1 ? 'sesión' : 'sesiones'}`, pct: Math.min(100, sem.sesionesFuerza * 50), color: '#b6ff2e' }
  ].map(o => `
    <div class="objetivo-fila">
      <div><span class="objetivo-nombre">${o.nombre}</span><span class="objetivo-valor">${o.valor}</span></div>
      <div class="pista"><div style="width:${o.pct}%;background:${o.color}"></div></div>
    </div>`).join('');

  // tarjetas
  const semanas = kmPorSemana();
  const ult4 = semanas.slice(-4), prev4 = semanas.slice(-8, -4);
  const mediaRitmo = l => {
    const km = l.reduce((s, x) => s + x.km, 0), min = l.reduce((s, x) => s + x.min, 0);
    return ritmo(km, min);
  };
  const rAhora = mediaRitmo(ult4), rAntes = mediaRitmo(prev4);
  const delta = rAhora && rAntes ? Math.round((rAntes - rAhora) * 60) : null;
  const totalKm = datos.running.reduce((s, e) => s + e.distancia, 0);
  const totalVol = datos.fuerza.reduce((s, e) => s + (e.series || 0) * (e.reps || 0) * (e.peso || 0), 0);
  const nSesFuerza = new Set(datos.fuerza.map(e => e.fecha)).size;
  const ultRodilla = [...datos.running].reverse().find(e => (e.rodilla || 0) > 0);
  const diasSinDolor = ultRodilla
    ? Math.round((Date.now() - desdeISO(ultRodilla.fecha)) / 86400000)
    : null;

  $('#cards-resumen').innerHTML = [
    {
      valor: rAhora ? `${fmtRitmo(rAhora)}` : '—', etiqueta: 'Ritmo medio (4 sem)',
      sub: delta === null ? 'sin comparativa aún' : delta > 0 ? `${delta} s/km más rápido` : delta < 0 ? `${-delta} s/km más lento` : 'igual que antes',
      color: 'var(--accent)'
    },
    { valor: num(totalKm), etiqueta: 'Km acumulados', sub: `${semanas.length} ${semanas.length === 1 ? 'semana' : 'semanas'} registradas`, color: 'var(--text)' },
    { valor: nSesFuerza, etiqueta: 'Sesiones de fuerza', sub: `${num(totalVol / 1000, 1)} t movidas`, color: 'var(--accent-2)' },
    {
      valor: ultRodilla ? `${ultRodilla.rodilla}/10` : '0/10', etiqueta: 'Rodilla',
      sub: diasSinDolor === null ? 'sin molestias registradas' : `última molestia hace ${diasSinDolor} d`,
      color: 'var(--text)'
    }
  ].map(c => `
    <div class="card">
      <div class="valor" style="color:${c.color}">${c.valor}</div>
      <div class="etiqueta">${c.etiqueta}</div>
      <div class="sub">${c.sub}</div>
    </div>`).join('');

  const tendencia = delta > 0
    ? `Tu ritmo medio ha bajado ${delta} s/km en el último mes.`
    : semanas.length < 2
      ? 'Con dos semanas de datos empezarás a ver la tendencia.'
      : 'Ritmo estable en el último mes.';
  $('#nota-tendencia').textContent = tendencia;

  // zonas FC
  const z = zonasFC();
  $('#nota-zonas').textContent = !z.max
    ? 'Pon tu FC máxima o tu edad en Cuenta para calcular las zonas.'
    : z.total
      ? `Reparto del tiempo en carrera — últimos 30 días (${fmtHoras(z.total)}, FC máx ${z.max})`
      : 'Apunta la FC media de tus entrenos (en “+ FC, dolor y notas”) para ver el reparto.';
  $('#zonas-barra').innerHTML = z.total
    ? z.lista.map(x => `<div style="flex-basis:${x.pct}%;background:${x.color}"></div>`).join('')
    : '<div style="flex:1;background:rgba(255,255,255,.06)"></div>';
  $('#zonas-lista').innerHTML = z.lista.map(x => `
    <div class="zona-fila">
      <span class="zona-punto" style="background:${x.color}"></span>
      <span class="zona-nombre">${x.nombre}</span>
      <span class="zona-rango">${z.max ? x.rango : '—'}</span>
      <span class="zona-tiempo">${x.minutos ? fmtHoras(x.minutos) : '—'}</span>
    </div>`).join('');
}

function renderRecords() {
  const prs = calcularRecords();
  $('#lista-records').innerHTML = prs.map(r => {
    if (!r.tiempo) return `
      <div class="pr">
        <div class="pr-head"><span class="eyebrow">${r.label}</span><span class="chip">Sin datos</span></div>
        <div class="pr-tiempo" style="color:var(--dim-2)">—</div>
        <div class="pr-meta">Registra un entreno de ${r.label} o añádelo a mano</div>
      </div>`;
    const chip = r.manual ? '<span class="chip chip-on">A mano</span>'
      : r.exacto ? '<span class="chip chip-on">Exacto</span>'
      : '<span class="chip chip-aprox">Estimado</span>';
    return `
      <div class="pr">
        <div class="pr-head"><span class="eyebrow">${r.label}</span>${chip}</div>
        <div class="pr-tiempo">${fmtTiempo(r.tiempo)}</div>
        <div class="pr-meta">${fmtRitmo(r.tiempo / r.d)} /km · ${fechaLarga(r.fecha)}</div>
      </div>`;
  }).join('');

  const metas = datos.perfil.metas || [];
  $('#lista-metas').innerHTML = metas.length ? metas.map((m, i) => {
    const p = progresoMeta(m, prs);
    return `
      <div class="meta">
        <div class="meta-head">
          <span class="meta-nombre">${escapar(m.nombre)}</span>
          <span style="font-size:.72rem;font-weight:800;color:${p.color}">${p.estado}
            <button class="btn-link" data-meta="${i}" style="margin-left:10px;color:var(--dim-2)">quitar</button>
          </span>
        </div>
        <div class="pista"><div style="width:${p.pct}%;background:${p.barra}"></div></div>
        <div class="meta-detalle">${p.detalle}</div>
      </div>`;
  }).join('') : '<p class="vacio">Sin metas todavía. Pulsa «Nueva meta» para añadir una.</p>';
}

function progresoMeta(m, prs) {
  if (m.tipo === 'tiempo') {
    const pr = prs.find(r => r.clave === m.distancia);
    const objetivo = m.objetivo; // minutos
    if (!pr || !pr.tiempo) return { pct: 0, estado: 'Sin datos', color: 'var(--dim)', barra: 'var(--accent)', detalle: `Necesitas al menos un entreno de esa distancia.` };
    const pct = Math.max(0, Math.min(100, (objetivo / pr.tiempo) * 100));
    const dif = pr.tiempo - objetivo;
    if (dif <= 0) return { pct: 100, estado: 'Conseguido', color: 'var(--accent-2)', barra: 'linear-gradient(90deg,#ff7a1a,#b6ff2e)', detalle: `Ya lo has bajado: ${fmtTiempo(pr.tiempo)}.` };
    return {
      pct, estado: dif < objetivo * .04 ? 'A tiro' : 'En camino',
      color: dif < objetivo * .04 ? 'var(--accent-2)' : 'var(--amber)',
      barra: 'linear-gradient(90deg,#ff7a1a,#b6ff2e)',
      detalle: `Vas por ${fmtTiempo(pr.tiempo)}; faltan ${fmtTiempo(dif)} para ${fmtTiempo(objetivo)}.`
    };
  }
  // tipo km en un mes
  const mes = (m.mes || hoyISO().slice(0, 7));
  const km = datos.running.filter(e => e.fecha.startsWith(mes)).reduce((s, e) => s + e.distancia, 0);
  const pct = Math.min(100, (km / m.objetivo) * 100);
  return {
    pct, estado: pct >= 100 ? 'Conseguido' : pct > 60 ? 'En camino' : 'Empezando',
    color: pct >= 100 ? 'var(--accent-2)' : pct > 60 ? 'var(--amber)' : 'var(--dim)',
    barra: '#b6ff2e',
    detalle: `${num(km)} de ${m.objetivo} km en ${mes}.`
  };
}

function renderListaRunning() {
  const lista = [...datos.running].reverse();
  const cont = $('#lista-running');
  if (!lista.length) { cont.innerHTML = '<p class="vacio">Todavía no has registrado ningún entreno.</p>'; return; }
  const max = fcMaxima();
  cont.innerHTML = lista.slice(0, 20).map(e => {
    const color = e.tipo === 'Series' ? '#ff5c5c' : e.tipo === 'Largo' ? '#b6ff2e' : 'var(--accent)';
    let zona = '';
    if (e.fcMedia && max) {
      const r = e.fcMedia / max;
      const n = r < .6 ? 1 : r < .7 ? 2 : r < .8 ? 3 : r < .9 ? 4 : 5;
      const c = ['#5c7cff', '#b6ff2e', '#ffcd50', '#ff7a1a', '#ff5c5c'][n - 1];
      zona = `<span class="badge" style="background:${c}28;color:${c}">Z${n}</span>`;
    }
    return `
      <div class="item">
        <span class="punto" style="background:${color}"></span>
        <div class="cuerpo">
          <div class="fecha">${fechaLarga(e.fecha)} · ${escapar(e.tipo)}</div>
          <div class="titulo">${num(e.distancia, 2)} km · ${fmtRitmo(ritmo(e.distancia, e.duracion))} /km</div>
          <div class="detalle">${fmtTiempo(e.duracion)} · RPE ${e.rpe ?? '—'}${e.fcMedia ? ` · FC ${e.fcMedia} ppm` : ''}${e.rodilla ? ` · rodilla ${e.rodilla}/10` : ''}${e.dolorValor ? ` · dolor ${e.dolorValor}/10${e.dolorZona ? ` (${escapar(e.dolorZona)})` : ''}` : ''}</div>
          ${e.notas ? `<div class="detalle">${escapar(e.notas)}</div>` : ''}
        </div>
        ${zona}
        <button class="btn-borrar" data-borrar="running" data-id="${e.id}" title="Eliminar">✕</button>
      </div>`;
  }).join('');
}

function renderFuerza() {
  const ejercicios = [...new Set(datos.fuerza.map(e => e.ejercicio))].sort();
  $('#lista-ejercicios').innerHTML = ejercicios.map(e => `<option value="${escapar(e)}">`).join('');
  if (!ejercicioActivo || !ejercicios.includes(ejercicioActivo)) ejercicioActivo = ejercicios[0] || null;
  $('#pills-ejercicios').innerHTML = ejercicios.length
    ? ejercicios.map(e => `<button type="button" class="pill ${e === ejercicioActivo ? 'active' : ''}" data-ejercicio="${escapar(e)}">${escapar(e)}</button>`).join('')
    : '';

  const sesiones = sesionesFuerza().reverse();
  const cont = $('#lista-fuerza');
  if (!sesiones.length) { cont.innerHTML = '<p class="vacio">Todavía no has registrado ninguna sesión.</p>'; return; }
  cont.innerHTML = sesiones.slice(0, 12).map(s => {
    const ejs = datos.fuerza.filter(e => e.fecha === s.fecha);
    return `
      <div class="item">
        <span class="punto" style="background:var(--accent-2)"></span>
        <div class="cuerpo">
          <div class="fecha">${fechaLarga(s.fecha)}</div>
          <div class="titulo">${s.ejercicios} ${s.ejercicios === 1 ? 'ejercicio' : 'ejercicios'} · ${num(s.volumen, 0)} kg</div>
          <div class="detalle">${ejs.map(e => `${escapar(e.ejercicio)} ${e.series}×${e.reps} @ ${e.peso}kg`).join(' · ')}</div>
        </div>
        <button class="btn-borrar" data-borrar-sesion="${s.fecha}" title="Eliminar sesión">✕</button>
      </div>`;
  }).join('');
}

function renderSemana() {
  const f = $('#form-semana');
  const sem = semanaActual();
  f.fecha.value = sem.inicio;
  f.kmTotales.value = sem.km ? sem.km.toFixed(1) : '';
  f.entrenosCompletados.value = sem.sesiones || '';
  f.entrenosPlaneados.value = datos.perfil.objetivoSesiones || '';
  const ultima = datos.semanas[datos.semanas.length - 1];
  $('#hint-peso').textContent = ultima?.peso ? `La semana pasada: ${num(ultima.peso)} kg` : 'Escríbelo tú';

  const cont = $('#lista-semanas');
  const lista = [...datos.semanas].reverse();
  if (!lista.length) { cont.innerHTML = '<p class="vacio">Sin check-ins todavía.</p>'; return; }
  const objetivoKm = datos.perfil.objetivoKm || 0;
  cont.innerHTML = lista.map(e => {
    const pct = objetivoKm && e.kmTotales ? Math.round((e.kmTotales / objetivoKm) * 100) : null;
    const color = pct === null ? 'var(--dim)' : pct >= 95 ? 'var(--accent-2)' : pct >= 75 ? 'var(--amber)' : 'var(--danger)';
    return `
      <div class="item">
        <div class="cuerpo">
          <div class="fecha">Semana del ${fechaLarga(e.fecha)}</div>
          <div class="titulo">${e.kmTotales ? `${num(e.kmTotales)} km` : '—'} · ${e.entrenosCompletados ?? '—'}${e.entrenosPlaneados ? ` de ${e.entrenosPlaneados}` : ''} sesiones${e.peso ? ` · ${num(e.peso)} kg` : ''}</div>
          <div class="detalle">${e.suenoHoras ? `Sueño ${num(e.suenoHoras)} h (${e.suenoCalidad}/5) · ` : ''}fatiga ${e.fatiga ?? '—'}/10${e.dolorValor ? ` · dolor ${e.dolorValor}/10${e.dolorZona ? ` (${escapar(e.dolorZona)})` : ''}` : ''}</div>
          ${e.destacable ? `<div class="detalle">${escapar(e.destacable)}</div>` : ''}
        </div>
        <span class="vol" style="color:${color}">${pct === null ? '' : pct + '%'}</span>
        <button class="btn-borrar" data-borrar="semanas" data-id="${e.id}" title="Eliminar">✕</button>
      </div>`;
  }).join('');
}

function renderHistorial() {
  const todo = [
    ...datos.running.map(e => ({
      tipo: 'running', fecha: e.fecha, id: e.id,
      titulo: `${num(e.distancia, 2)} km · ${escapar(e.tipo)}`,
      extra: `${fmtRitmo(ritmo(e.distancia, e.duracion))} /km`
    })),
    ...datos.fuerza.map(e => ({
      tipo: 'fuerza', fecha: e.fecha, id: e.id,
      titulo: `${escapar(e.ejercicio)} — ${e.series}×${e.reps} @ ${e.peso} kg`,
      extra: `${num(e.series * e.reps * e.peso, 0)} kg`
    }))
  ].sort((a, b) => b.fecha.localeCompare(a.fecha))
    .filter(e => filtroHistorial === 'todos' || e.tipo === filtroHistorial);

  const cont = $('#lista-historial');
  if (!todo.length) { cont.innerHTML = '<p class="vacio">No hay entrenos que mostrar.</p>'; return; }
  cont.innerHTML = todo.map(e => `
    <div class="item">
      <span class="badge ${e.tipo}">${e.tipo === 'running' ? 'Running' : 'Fuerza'}</span>
      <div class="cuerpo">
        <div class="titulo">${e.titulo}</div>
        <div class="detalle">${fechaLarga(e.fecha)}</div>
      </div>
      <span class="extra">${e.extra}</span>
      <button class="btn-borrar" data-borrar="${e.tipo}" data-id="${e.id}" title="Eliminar">✕</button>
    </div>`).join('');
}

/* ------------------------------------------------------------------ */
/* 8) FORMULARIOS                                                      */
/* ------------------------------------------------------------------ */
$('#escala-rpe').innerHTML = Array.from({ length: 11 }, (_, n) =>
  `<button type="button" data-rpe="${n}" class="${n === 6 ? 'on' : ''}">${n}</button>`).join('');
$('#escala-rpe').addEventListener('click', e => {
  const b = e.target.closest('[data-rpe]');
  if (!b) return;
  $$('#escala-rpe button').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  $('#form-running [name=rpe]').value = b.dataset.rpe;
});

$('#btn-avanzado').addEventListener('click', () => {
  const c = $('#campos-avanzados');
  c.hidden = !c.hidden;
  $('#btn-avanzado').textContent = c.hidden ? '+ FC, dolor y notas' : '− Ocultar FC, dolor y notas';
});

$('#form-running').addEventListener('submit', async e => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target).entries());
  const entreno = {
    id: generarId(),
    fecha: d.fecha,
    distancia: parseFloat(d.distancia),
    duracion: parseFloat(d.duracion),
    tipo: d.tipo,
    fcMedia: d.fcMedia ? parseInt(d.fcMedia, 10) : null,
    fcMaxima: d.fcMaxima ? parseInt(d.fcMaxima, 10) : null,
    rpe: parseInt(d.rpe, 10),
    rodilla: parseInt(d.rodilla || 0, 10),
    dolorValor: parseInt(d.dolorValor || 0, 10),
    dolorZona: (d.dolorZona || '').trim(),
    notas: (d.notas || '').trim()
  };
  cargando(true);
  try {
    await guardar('running', entreno);
    datos.running.push(entreno);
    datos.running.sort((a, b) => a.fecha.localeCompare(b.fecha));
    e.target.reset();
    e.target.fecha.value = hoyISO();
    e.target.rpe.value = 6;
    $('#nota-import').hidden = true;
    renderizar();
    irA('resumen');
  } catch (err) { console.error(err); alert('No se ha podido guardar.'); }
  finally { cargando(false); }
});

/* --- fuerza --- */
function renderPendientes() {
  const c = $('#lista-pendientes');
  c.innerHTML = pendientes.length ? pendientes.map((p, i) => `
    <div class="item">
      <div class="cuerpo">
        <div class="titulo">${escapar(p.ejercicio)} — ${p.series}×${p.reps} @ ${p.peso} kg</div>
        ${p.notas ? `<div class="detalle">${escapar(p.notas)}</div>` : ''}
      </div>
      <span class="vol">${num(p.series * p.reps * p.peso, 0)} kg</span>
      <button class="btn-borrar" data-pendiente="${i}" title="Quitar">✕</button>
    </div>`).join('')
    : '<p class="vacio">Todavía no has añadido ningún ejercicio.</p>';
  $('#btn-guardar-sesion').disabled = pendientes.length === 0;
}
renderPendientes();

$('#btn-anadir-ejercicio').addEventListener('click', () => {
  const f = $('#form-fuerza');
  const ejercicio = f.ejercicio.value.trim();
  const series = parseInt(f.series.value, 10);
  const reps = parseInt(f.reps.value, 10);
  const peso = parseFloat(f.peso.value);
  if (!ejercicio || !series || !reps || isNaN(peso)) {
    alert('Rellena ejercicio, series, repeticiones y peso.');
    return;
  }
  pendientes.push({ ejercicio, series, reps, peso, notas: f.notas.value.trim() });
  renderPendientes();
  f.ejercicio.value = ''; f.peso.value = ''; f.notas.value = '';
  f.series.value = series; f.reps.value = reps;
  f.ejercicio.focus();
});

$('#lista-pendientes').addEventListener('click', e => {
  const b = e.target.closest('[data-pendiente]');
  if (!b) return;
  pendientes.splice(parseInt(b.dataset.pendiente, 10), 1);
  renderPendientes();
});

$('#form-fuerza').addEventListener('submit', async e => {
  e.preventDefault();
  if (!pendientes.length) return;
  const fecha = e.target.fecha.value;
  cargando(true);
  try {
    for (const p of pendientes) {
      const doc = { id: generarId(), fecha, ...p };
      await guardar('fuerza', doc);
      datos.fuerza.push(doc);
    }
    datos.fuerza.sort((a, b) => a.fecha.localeCompare(b.fecha));
    pendientes = [];
    renderPendientes();
    e.target.reset();
    e.target.fecha.value = hoyISO();
    e.target.series.value = 3;
    e.target.reps.value = 10;
    renderizar();
  } catch (err) { console.error(err); alert('No se ha podido guardar la sesión.'); }
  finally { cargando(false); }
});

$('#pills-ejercicios').addEventListener('click', e => {
  const b = e.target.closest('[data-ejercicio]');
  if (!b) return;
  ejercicioActivo = b.dataset.ejercicio;
  renderFuerza();
  graficaEjercicio();
});

/* --- check-in semanal --- */
$('#form-semana').addEventListener('submit', async e => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target).entries());
  const doc = {
    id: generarId(),
    fecha: d.fecha,
    peso: d.peso ? parseFloat(d.peso) : null,
    kmTotales: d.kmTotales ? parseFloat(d.kmTotales) : null,
    entrenosCompletados: d.entrenosCompletados ? parseInt(d.entrenosCompletados, 10) : null,
    entrenosPlaneados: d.entrenosPlaneados ? parseInt(d.entrenosPlaneados, 10) : null,
    suenoHoras: d.suenoHoras ? parseFloat(d.suenoHoras) : null,
    suenoCalidad: parseInt(d.suenoCalidad || 3, 10),
    fatiga: parseInt(d.fatiga || 0, 10),
    dolorValor: parseInt(d.dolorValor || 0, 10),
    dolorZona: (d.dolorZona || '').trim(),
    destacable: (d.destacable || '').trim()
  };
  cargando(true);
  try {
    await guardar('semanas', doc);
    datos.semanas.push(doc);
    datos.semanas.sort((a, b) => a.fecha.localeCompare(b.fecha));
    e.target.destacable.value = '';
    renderizar();
    alert('Check-in guardado.');
  } catch (err) { console.error(err); alert('No se ha podido guardar.'); }
  finally { cargando(false); }
});

/* --- perfil --- */
$('#form-perfil').addEventListener('submit', async e => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target).entries());
  cargando(true);
  try {
    await guardarPerfil({
      nombre: d.nombre.trim() || 'Cuenta',
      fcMax: d.fcMax ? parseInt(d.fcMax, 10) : null,
      edad: d.edad ? parseInt(d.edad, 10) : null,
      objetivoKm: d.objetivoKm ? parseFloat(d.objetivoKm) : 0,
      objetivoSesiones: d.objetivoSesiones ? parseInt(d.objetivoSesiones, 10) : 0
    });
    pintarUsuario();
    renderizar();
    alert('Perfil guardado.');
  } catch (err) { console.error(err); alert('No se ha podido guardar el perfil.'); }
  finally { cargando(false); }
});

/* --- filtros historial --- */
$('#filtros-historial').addEventListener('click', e => {
  const b = e.target.closest('[data-filtro]');
  if (!b) return;
  $$('#filtros-historial .pill').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  filtroHistorial = b.dataset.filtro;
  renderHistorial();
});

/* --- borrados --- */
document.addEventListener('click', async e => {
  const uno = e.target.closest('[data-borrar]');
  if (uno) {
    if (!confirm('¿Eliminar este registro?')) return;
    const { borrar: colName, id } = uno.dataset;
    cargando(true);
    try {
      await borrar(colName, id);
      datos[colName] = datos[colName].filter(x => x.id !== id);
      renderizar();
    } finally { cargando(false); }
    return;
  }
  const sesion = e.target.closest('[data-borrar-sesion]');
  if (sesion) {
    const fecha = sesion.dataset.borrarSesion;
    if (!confirm('¿Eliminar la sesión completa de ese día?')) return;
    cargando(true);
    try {
      const ejs = datos.fuerza.filter(x => x.fecha === fecha);
      for (const x of ejs) await borrar('fuerza', x.id);
      datos.fuerza = datos.fuerza.filter(x => x.fecha !== fecha);
      renderizar();
    } finally { cargando(false); }
  }
  const quitarMeta = e.target.closest('[data-meta]');
  if (quitarMeta) {
    const i = parseInt(quitarMeta.dataset.meta, 10);
    const metas = [...(datos.perfil.metas || [])];
    metas.splice(i, 1);
    await guardarPerfil({ metas });
    renderRecords();
  }
});

/* ------------------------------------------------------------------ */
/* 9) IMPORTAR .GPX / .TCX                                             */
/* ------------------------------------------------------------------ */
function distanciaKm(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function parsearActividad(texto) {
  const doc = new DOMParser().parseFromString(texto, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('El archivo no es un XML válido.');

  const puntos = [];
  const hrs = [];
  const nodos = doc.getElementsByTagName('trkpt').length
    ? doc.getElementsByTagName('trkpt')
    : doc.getElementsByTagName('Trackpoint');

  for (const n of nodos) {
    let lat = parseFloat(n.getAttribute('lat'));
    let lon = parseFloat(n.getAttribute('lon'));
    if (isNaN(lat)) {
      lat = parseFloat(n.getElementsByTagName('LatitudeDegrees')[0]?.textContent);
      lon = parseFloat(n.getElementsByTagName('LongitudeDegrees')[0]?.textContent);
    }
    const t = n.getElementsByTagName('Time')[0]?.textContent || n.getElementsByTagName('time')[0]?.textContent;
    const hr = n.getElementsByTagName('Value')[0]?.textContent
      || [...n.getElementsByTagName('*')].find(x => x.tagName.toLowerCase().endsWith('hr'))?.textContent;
    if (hr) hrs.push(parseInt(hr, 10));
    if (!isNaN(lat) && !isNaN(lon)) puntos.push({ lat, lon, t: t ? new Date(t) : null });
  }

  // distancia: preferimos la que trae el archivo (TCX) si existe
  let km = 0;
  const metros = [...doc.getElementsByTagName('DistanceMeters')].map(x => parseFloat(x.textContent)).filter(n => !isNaN(n));
  if (metros.length) km = Math.max(...metros) / 1000;
  else for (let i = 1; i < puntos.length; i++) km += distanciaKm(puntos[i - 1], puntos[i]);

  const tiempos = puntos.map(p => p.t).filter(Boolean);
  const inicio = tiempos[0] || (doc.getElementsByTagName('time')[0] ? new Date(doc.getElementsByTagName('time')[0].textContent) : null);
  const fin = tiempos[tiempos.length - 1];
  const minutos = inicio && fin ? (fin - inicio) / 60000 : 0;

  if (!km && !minutos) throw new Error('No he encontrado puntos de recorrido en el archivo.');

  return {
    km: Math.round(km * 100) / 100,
    minutos: Math.round(minutos * 10) / 10,
    fecha: isoLocal(inicio || new Date()),
    fcMedia: hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null,
    fcMaxima: hrs.length ? Math.max(...hrs) : null
  };
}

function abrirSelectorArchivo() { $('#input-archivo').click(); }
$('#btn-importar-archivo').addEventListener('click', abrirSelectorArchivo);
$('#btn-importar-cuenta').addEventListener('click', () => { irA('running'); abrirSelectorArchivo(); });

$('#input-archivo').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const nota = $('#nota-import');
  try {
    const a = parsearActividad(await file.text());
    const f = $('#form-running');
    f.fecha.value = a.fecha;
    f.distancia.value = a.km || '';
    f.duracion.value = a.minutos || '';
    if (a.fcMedia) {
      $('#campos-avanzados').hidden = false;
      $('#btn-avanzado').textContent = '− Ocultar FC, dolor y notas';
      f.fcMedia.value = a.fcMedia;
      f.fcMaxima.value = a.fcMaxima;
    }
    f.tipo.value = a.km >= 15 ? 'Largo' : 'Rodaje';
    nota.hidden = false;
    nota.innerHTML = `<strong style="color:var(--accent-2)">${escapar(file.name)}</strong> leído: ${num(a.km, 2)} km en ${fmtTiempo(a.minutos)}${a.fcMedia ? ` · FC media ${a.fcMedia} ppm` : ''}. Revisa el tipo y guarda.`;
    irA('running');
  } catch (err) {
    nota.hidden = false;
    nota.innerHTML = `<span style="color:var(--danger)">No he podido leer ${escapar(file.name)}: ${escapar(err.message)}</span> Si es un .fit, expórtalo como .gpx o .tcx.`;
  } finally { e.target.value = ''; }
});

/* ------------------------------------------------------------------ */
/* 10) MODAL (récord a mano / nueva meta)                              */
/* ------------------------------------------------------------------ */
let modalSubmit = null;
function abrirModal(titulo, campos, onSubmit) {
  $('#modal-titulo').textContent = titulo;
  $('#modal-campos').innerHTML = campos.map(c => c.html).join('');
  modalSubmit = onSubmit;
  $('#modal').hidden = false;
}
function cerrarModal() { $('#modal').hidden = true; modalSubmit = null; }
$('#modal-cerrar').addEventListener('click', cerrarModal);
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') cerrarModal(); });
$('#modal-form').addEventListener('submit', async e => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target).entries());
  if (modalSubmit) await modalSubmit(d);
  cerrarModal();
});

const minutosDeTexto = t => {
  const p = String(t).split(':').map(Number);
  if (p.some(isNaN)) return NaN;
  return p.length === 3 ? p[0] * 60 + p[1] + p[2] / 60 : p.length === 2 ? p[0] + p[1] / 60 : p[0];
};

$('#btn-pr-manual').addEventListener('click', () => {
  abrirModal('Récord a mano', [
    { html: `<label class="full">Distancia<select name="distancia">${DISTANCIAS_PR.map(d => `<option value="${d.clave}">${d.label}</option>`).join('')}</select></label>` },
    { html: `<label>Tiempo<input name="tiempo" placeholder="50:22 o 1:52:30" required></label>` },
    { html: `<label>Fecha<input type="date" name="fecha" value="${hoyISO()}" required></label>` }
  ], async d => {
    const tiempo = minutosDeTexto(d.tiempo);
    if (isNaN(tiempo)) return alert('Escribe el tiempo como mm:ss o h:mm:ss.');
    const prsManual = { ...(datos.perfil.prsManual || {}), [d.distancia]: { tiempo, fecha: d.fecha } };
    await guardarPerfil({ prsManual });
    renderRecords();
  });
});

$('#btn-nueva-meta').addEventListener('click', () => {
  abrirModal('Nueva meta', [
    { html: `<label class="full">Tipo<select name="tipo"><option value="tiempo">Bajar de un tiempo</option><option value="km">Kilómetros en un mes</option></select></label>` },
    { html: `<label class="full">Nombre<input name="nombre" placeholder="Bajar de 50:00 en 10 km" required></label>` },
    { html: `<label>Distancia<select name="distancia">${DISTANCIAS_PR.map(d => `<option value="${d.clave}">${d.label}</option>`).join('')}</select></label>` },
    { html: `<label>Objetivo<input name="objetivo" placeholder="50:00 · o 160 (km)" required></label>` },
    { html: `<label class="full">Mes (solo para km)<input type="month" name="mes" value="${hoyISO().slice(0, 7)}"></label>` }
  ], async d => {
    const objetivo = d.tipo === 'tiempo' ? minutosDeTexto(d.objetivo) : parseFloat(d.objetivo);
    if (isNaN(objetivo)) return alert('El objetivo no es válido.');
    const metas = [...(datos.perfil.metas || []), {
      tipo: d.tipo, nombre: d.nombre.trim(), objetivo,
      distancia: d.distancia, mes: d.mes
    }];
    await guardarPerfil({ metas });
    renderRecords();
  });
});

/* ------------------------------------------------------------------ */
/* 11) EXPORTAR / BORRAR                                               */
/* ------------------------------------------------------------------ */
$('#btn-exportar').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(datos, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `entrenos_${hoyISO()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#btn-borrar').addEventListener('click', async () => {
  if (!confirm('Esto borrará TODOS tus entrenos. ¿Seguro?')) return;
  if (!confirm('No se puede deshacer. ¿Confirmas?')) return;
  cargando(true);
  try {
    for (const nombre of ['running', 'fuerza', 'semanas']) {
      const snap = await col(nombre).get();
      if (snap.empty) continue;
      const lote = db.batch();
      snap.docs.forEach(d => lote.delete(d.ref));
      await lote.commit();
    }
    datos.running = []; datos.fuerza = []; datos.semanas = [];
    renderizar();
  } finally { cargando(false); }
});

/* ------------------------------------------------------------------ */
/* 12) ARRANQUE                                                        */
/* ------------------------------------------------------------------ */
$('#form-running [name=fecha]').value = hoyISO();
$('#form-fuerza [name=fecha]').value = hoyISO();
$('#auth-gate').hidden = false;
cargando(true);
