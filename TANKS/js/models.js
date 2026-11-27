'use strict';
/**
 * ============================================================================
 *  models.js — Modelos de tanque predeterminados.
 * ============================================================================
 *  Cada modelo define:
 *    - colors:  paleta propia (body/dark/light) o null = colores por slot.
 *    - effect:  color del destello de disparo y la estela del motor.
 *    - mods:    modificadores de juego (speed, turn, fireRate, bulletSpeed,
 *               bounces extra, shield = absorbe un impacto por ronda).
 *  El modelo elegido se guarda en localStorage y se comparte por la red:
 *  el cliente lo envía al host en el JOIN y el host lo incluye en los
 *  snapshots (serializeMeta) para que todos vean colores y efectos.
 * ============================================================================
 */

/** Modificadores por defecto (sin cambios). */
const DEFAULT_MODS = Object.freeze({
  speed: 1, turn: 1, fireRate: 1, bulletSpeed: 1, bounces: 0, shield: false, spread: false, cryo: false, pride: false, cruzazul: false, america: false, void01: false, atlas: false,
});

const TANK_MODELS = [
  {
    id: 'clasico', name: 'Clásico', desc: 'Sin cambios. El tanque de siempre.',
    colors: null, effect: '#ffd75e',
    mods: { speed: 1, turn: 1, fireRate: 1, bulletSpeed: 1, bounces: 0, shield: false },
  },
  {
    id: 'veloz', name: 'Veloz', desc: 'Más velocidad y giro, pero dispara más lento.',
    colors: { body: '#e67e22', dark: '#9c4a12', light: '#f5b041' }, effect: '#ff9f43',
    mods: { speed: 1.3, turn: 1.25, fireRate: 0.85, bulletSpeed: 1, bounces: 0, shield: false },
  },
  {
    id: 'blindado', name: 'Blindado', desc: 'Escudo que absorbe un impacto por ronda. Más lento.',
    colors: { body: '#5d7a99', dark: '#34495e', light: '#a9cce3' }, effect: '#7fd4ff',
    mods: { speed: 0.85, turn: 0.85, fireRate: 1, bulletSpeed: 1, bounces: 0, shield: true },
  },
  {
    id: 'francotirador', name: 'Francotirador', desc: 'Balas mucho más rápidas, cadencia baja.',
    colors: { body: '#2e7d32', dark: '#1b5e20', light: '#66bb6a' }, effect: '#4dff88',
    mods: { speed: 0.92, turn: 1, fireRate: 0.7, bulletSpeed: 1.35, bounces: 0, shield: false },
  },
  {
    id: 'ametralladora', name: 'Ametralladora', desc: 'Cadencia altísima, balas más lentas.',
    colors: { body: '#f1c40f', dark: '#9a7d0a', light: '#f9e79f' }, effect: '#ff6b35',
    mods: { speed: 1, turn: 1.1, fireRate: 1.8, bulletSpeed: 0.8, bounces: 0, shield: false },
  },
  {
    id: 'rebotador', name: 'Rebotador', desc: 'Sus balas rebotan una vez más.',
    colors: { body: '#8e44ad', dark: '#5b2c6f', light: '#bb8fce' }, effect: '#c792ff',
    mods: { speed: 0.95, turn: 1, fireRate: 1, bulletSpeed: 1, bounces: 1, shield: false },
  },
  {
    id: 'destructor', name: 'Destructor', desc: 'Disparo triple con cañones gemelos. Diseño pesado con torreta giratoria.',
    colors: { body: '#c0392b', dark: '#7b241c', light: '#f1948a' }, effect: '#ff6b6b',
    custom: 'destructor',
    mods: { speed: 0.95, turn: 0.95, fireRate: 0.85, bulletSpeed: 1, bounces: 0, shield: false, spread: true },
  },
  {
    id: 'cryo', name: 'CRYO-01 FROST REAPER', desc: 'Tanque criogénico: congela enemigos con su Cryo Cannon y congela el campo con CERO ABSOLUTO (clic derecho).',
    colors: { body: '#e8f4fa', dark: '#8fb8d8', light: '#ffffff' }, effect: '#7fe3ff',
    custom: 'cryo',
    mods: { speed: 0.85, turn: 1, fireRate: 0.22 / 0.9, bulletSpeed: 1, bounces: 0, shield: false, cryo: true },
  },
  {
    id: 'cruzazul',
    name: 'LA MÁQUINA - CRUZ AZUL',
    short: 'CAZ',
    desc: 'Escudo celeste que absorbe un impacto · Descarga Celeste (clic der.) limpia balas, aturde y da impulso · Turbo Azul con Shift · Celebración AMO EL CRUZ AZUL',
    colors: { body: '#0b3d91', dark: '#062a66', light: '#6ab0ff' },
    effect: '#38b6ff',
    custom: 'cruzazul',
    mods: { speed: 1.08, turn: 1, fireRate: 1, bulletSpeed: 1, bounces: 0, shield: true, spread: false, cryo: false, pride: false, cruzazul: true },
  },
  {
    id: 'america',
    name: 'ÁGUILAS DEL AMÉRICA',
    short: 'AME',
    desc: 'Renacimiento fénix: revive 1 vez por ronda · Explosión Fénix (clic der.) limpia balas, aturde y da impulso · Turbo Águila con Shift · Celebración ARRIBA LAS ÁGUILAS DEL AMÉRICA',
    colors: { body: '#f9e700', dark: '#0b3d91', light: '#ffe95c' },
    effect: '#ff8c1a',
    custom: 'america',
    mods: { speed: 1.10, turn: 1.05, fireRate: 1, bulletSpeed: 1, bounces: 0, shield: false, spread: false, cryo: false, pride: false, cruzazul: false, america: true },
  },
  {
    id: 'void01',
    name: 'VOID-01 // SOMBRA NEGRA',
    short: 'VOID',
    desc: 'SECRETO: Bomba nuclear (N) · Aimbot (T) · Turbo infinito (Shift) · Escudo x3 · Teletransporte (V) · Disparo plasma',
    colors: { body: '#111111', dark: '#000000', light: '#00e5ff' },
    effect: '#00e5ff',
    custom: 'void01',
    mods: { speed: 1.25, turn: 1.2, fireRate: 1.5, bulletSpeed: 1.3, bounces: 1, shield: false, spread: false, cryo: false, pride: false, cruzazul: false, america: false, void01: true },
    secret: true,
  },
  {
    id: 'atlas',
    name: 'ATLAS FC',
    short: 'ATL',
    desc: 'Escudo rojinegro · Furia Rojinegra (clic der.) · Turbo Academia (Shift) · Celebración ARRIBA EL ATLAS',
    colors: { body: '#c0392b', dark: '#000000', light: '#e74c3c' },
    effect: '#e74c3c',
    custom: 'atlas',
    mods: { speed: 1.08, turn: 1, fireRate: 1, bulletSpeed: 1, bounces: 0, shield: true, spread: false, cryo: false, pride: false, cruzazul: false, america: false, void01: false, atlas: true },
  },
];

const MODEL_STORAGE_KEY = 'tanks-model-v1';

/** Devuelve el modelo con ese id, o el Clásico si no existe. */
function getTankModel(id) {
  return TANK_MODELS.find((m) => m.id === id) || TANK_MODELS[0];
}

/** Id del modelo elegido en el menú (o el guardado, o 'clasico'). */
function getSelectedModelId() {
  const sel = document.getElementById('model-select');
  if (sel && sel.value) return sel.value;
  try { return localStorage.getItem(MODEL_STORAGE_KEY) || 'clasico'; } catch (_) { return 'clasico'; }
}

window.TankModels = {
  list: TANK_MODELS,
  get: getTankModel,
  selectedId: getSelectedModelId,
  defaults: DEFAULT_MODS,
};

/** Cablea el <select> del menú: opciones, descripción y persistencia. */
function _initModelMenu() {
  const sel = document.getElementById('model-select');
  if (!sel) return;
  const desc = document.getElementById('model-desc');

  let unlocked = false;
  try { unlocked = localStorage.getItem('tanks-void01-unlocked') === '1'; } catch (_) {}

  for (const m of TANK_MODELS) {
    if (m.secret && !unlocked) continue; // oculto hasta desbloquear con código
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.secret ? m.name + ' [SECRETO]' : m.name;
    sel.appendChild(opt);
  }

  let saved = 'clasico';
  try { saved = localStorage.getItem(MODEL_STORAGE_KEY) || 'clasico'; } catch (_) {}
  if (!TANK_MODELS.some((m) => m.id === saved && (!m.secret || unlocked))) saved = 'clasico';
  sel.value = saved;

  const updateDesc = () => {
    if (!desc) return;
    desc.textContent = getTankModel(sel.value).desc;
  };
  updateDesc();

  sel.addEventListener('change', () => {
    try { localStorage.setItem(MODEL_STORAGE_KEY, sel.value); } catch (_) {}
    updateDesc();
  });
}

function unlockSecretModel() {
  const sel = document.getElementById('model-select');
  if (!sel) return false;
  const secret = TANK_MODELS.find((m) => m.secret);
  if (!secret) return false;
  try { localStorage.setItem('tanks-void01-unlocked', '1'); } catch (_) {}
  if (!sel.querySelector(`option[value="${secret.id}"]`)) {
    const opt = document.createElement('option');
    opt.value = secret.id;
    opt.textContent = secret.name + ' [SECRETO]';
    sel.appendChild(opt);
  }
  sel.value = secret.id;
  try { localStorage.setItem(MODEL_STORAGE_KEY, secret.id); } catch (_) {}
  const desc = document.getElementById('model-desc');
  if (desc) desc.textContent = secret.desc;
  return true;
}

window.TankModels.unlockSecret = unlockSecretModel;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initModelMenu);
} else {
  _initModelMenu();
}
