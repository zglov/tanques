'use strict';
/**
 * ============================================================================
 *  config.js — Parámetros globales y "tunables" del juego.
 * ============================================================================
 *  Todo valor numérico que afecte a la jugabilidad vive aquí. Esto es
 *  importante para el multijugador: host y clientes DEBEN compartir la misma
 *  configuración, de lo contrario las simulaciones divergen.
 *
 *  Unidades: píxeles (px), segundos (s) y radianes (rad).
 *  Convención de ángulos: 0 rad = mirando a la derecha (+X), crecen en sentido
 *  horario porque el eje Y del canvas apunta hacia abajo.
 * ============================================================================
 */
const CONFIG = Object.freeze({
  /** Tamaño de cada celda del mapa en px. */
  TILE_SIZE: 40,

  /** Paso fijo de simulación (60 Hz). La lógica SIEMPRE avanza en pasos de este tamaño. */
  FIXED_DT: 1 / 60,

  /** Máximo dt real aceptado por frame (evita la "espiral de la muerte" tras cambiar de pestaña). */
  MAX_FRAME_DT: 0.25,

  /** Límite de jugadores concurrentes (local + bots + remotos). */
  MAX_PLAYERS: 10,

  /** Frecuencia (Hz) con la que el host emite snapshots del GameState por la red. */
  NET_SEND_RATE: 20,

  /** Segundos sin recibir inputs de un peer antes de considerarlo desconectado. */
  NET_PEER_TIMEOUT: 5,

  TANK: Object.freeze({
    RADIUS: 15,            // radio de colisión (círculo)
    BODY_LENGTH: 32,       // largo visual del chasis
    BODY_WIDTH: 26,        // ancho visual del chasis
    BARREL_LENGTH: 22,     // largo del cañón desde el centro
    MAX_SPEED: 130,        // px/s velocidad máxima (en cualquier dirección)
    REVERSE_FACTOR: 0.72,  // factor en marcha atrás (modo diferencial clásico)
    ACCELERATION: 560,     // px/s² al acelerar (respuesta ágil y progresiva)
    BRAKE: 780,            // px/s² al invertir la marcha o frenar
    FRICTION: 8.5,         // decaimiento exponencial suave al soltar teclas (1/s)
    LATERAL_GRIP: 14,      // agarre lateral de las orugas (reduce derrape al girar)
    MAX_TURN_SPEED: 3.4,   // rad/s de giro del chasis
    TURN_ACCEL: 24,        // rad/s² aceleración angular suave (sin latigazos)
    TURN_FRICTION: 18,     // amortiguación angular al soltar giro (1/s)
    TURN_RESPONSE: 12,     // 1/s tasa de respuesta angular (CORREGIDO: faltaba y producía NaN)
    TURRET_SLEW_SPEED: 16, // rad/s velocidad máxima de seguimiento de la torreta
    TURRET_SMOOTHING: 22,  // suavizado exponencial de la torreta hacia el cursor
    FIRE_COOLDOWN: 0.22,   // s entre disparos
    MAX_ACTIVE_BULLETS: 5, // balas simultáneas por tanque (como en Wii Tanks)
    /**
     * Modo de conducción por defecto:
     *  - 'omni' : W/A/S/D mueven en las 8 direcciones de pantalla (estilo Wii Tanks
     *             con Nunchuk/cruceta) y el chasis rota suavemente hacia el rumbo,
     *             con inversión inteligente de marcha si el destino queda detrás.
     *  - 'tank' : W/S avanzan/retroceden según el chasis y A/D rotan las orugas,
     *             con inercia rotacional y agarre lateral suave.
     *  Se puede alternar en vivo con la tecla C.
     */
    DEFAULT_DRIVE_MODE: 'omni',
  }),

  BULLET: Object.freeze({
    SPEED: 250,            // px/s, constante durante toda la vida del proyectil
    RADIUS: 4,
    DEFAULT_BOUNCES: 1,    // rebotes permitidos antes de destruirse (1 o 2)
    MAX_BOUNCES: 2,
    MAX_LIFETIME: 12,      // s, red de seguridad
    SUBSTEP_PX: 3,         // distancia máxima por sub-paso (anti-tunneling)
  }),

  ROUND: Object.freeze({
    RESTART_DELAY: 3,      // s entre el fin de una ronda y la siguiente
  }),

  /**
   * Parámetros del tanque criogénico CRYO-01 FROST REAPER.
   * ADAPTACIÓN AL SISTEMA EXISTENTE: el juego es de un solo impacto (sin HP),
   * así que el "daño" de las balas criogénicas se traduce en pilas de
   * congelación y la "resistencia 130%" en un umbral mayor para congelarlo.
   */
  CRYO: Object.freeze({
    FREEZE_HITS: 3,            // impactos criogénicos para congelar a un tanque normal
    FREEZE_HITS_CRYO: 4,       // impactos para congelar al FROST REAPER (resistencia 130%)
    FREEZE_DURATION: 2.5,      // s que dura la congelación completa
    FREEZE_DECAY: 3,           // s sin recibir impactos antes de perder una pila
    SLOW_1_STACK: 0.4,         // 1 pila: -40 % de velocidad
    SLOW_2_STACKS: 0.75,       // 2 pilas: -75 % de velocidad
    SPECIAL_COOLDOWN: 25,      // s de recarga de CERO ABSOLUTO
    SPECIAL_RADIUS_TILES: 8,   // radio de la onda en casillas
    SPECIAL_FREEZE: 4,         // s de congelación de CERO ABSOLUTO
    SPECIAL_WAVE_SPEED: 420,   // px/s de expansión de la onda
    GROUND_FROST_TIME: 6,      // s que dura el suelo congelado
    GROUND_SLOW: 0.5,          // ralentización extra sobre suelo congelado
    SHATTER_ON_FROZEN: true,   // un impacto sobre un tanque congelado lo destruye
    FIRE_RATE_MOD: 0.22 / 0.9, // cadencia del Cryo Cannon: 0.9 s entre disparos
  }),

  /**
   * Parámetros del tanque PRIDE OVERLORD 🌈 — EL REY DEL ORGULLO.
   * ADAPTACIÓN AL SISTEMA EXISTENTE: el juego es de un solo impacto (sin HP).
   * El "blindaje 115 %" se traduce en que PRIDE absorbe un impacto por ronda
   * (escudo pasivo, como el Blindado); el daño de la onda, los pulsos de la
   * zona y la explosión se traducen en efectos de control (empuje, aturdimiento,
   * silencio) y la explosión del Rayo mata a los tanques dentro de su radio.
   */
  PRIDE: Object.freeze({
    SPEED_MULT: 1.10, // velocidad base (110 %)
    energy: Object.freeze({ max: 100, regeneration: 15 }), // ⚡ máx y regeneración por s
    primaryWeapon: Object.freeze({ cooldown: 0.55, speed: 250, radius: 4 }), // cañón prism
    chargedShot: Object.freeze({
      maxChargeTime: 1.5, cooldown: 4, energyCost: 25, minEnergyFraction: 0.25,
      minRadius: 5, maxRadius: 10, speed: 250,
      blastRadius: 46, // radio de explosión a carga completa (escala 0.5..1 con la carga)
      breakableBlast: true, // a carga completa rompe bloques destructibles en el radio
    }),
    prideWave: Object.freeze({ cooldown: 6, radius: 100, energyCost: 20, interruptDuration: 0.5, push: 46 }),
    rainbowShield: Object.freeze({ cooldown: 12, duration: 4, maxHits: 1, energyCost: 30 }), // absorbe 1 impacto y se rompe
    rainbowBoost: Object.freeze({ speedMultiplier: 1.70, energyDrainPerSecond: 35, minEnergyToStart: 10 }),
    sonicZone: Object.freeze({
      range: 300, radius: 110, warningTime: 0.8, duration: 5, stunDuration: 1,
      slowMultiplier: 0.65, energyCost: 60, cooldown: 25,
      pulseInterval: 0.5, fireInterrupt: 0.4,
    }),
    victoryCelebration: Object.freeze({ text: 'PRIDE OVERLORD DOMINA', duration: 3 }),
    portrait: null,
    audio: Object.freeze({ maxGain: 0.22, chargeGain: 0.06 }),
    particles: Object.freeze({ trailPerSecond: 40, boostPerSecond: 30, zonePerSecond: 14 }),
  }),

  /**
   * Parámetros del tanque CRUZ AZUL - LA MÁQUINA.
   * ADAPTACIÓN AL SISTEMA EXISTENTE: el juego es de un solo impacto (sin HP).
   * El "escudo celeste" absorbe un impacto por ronda (como Blindado);
   * la Descarga Celeste limpia balas, aturde y da impulso de velocidad;
   * el Turbo Azul es velocidad extra con Shift.
   */
  CRUZAZUL: Object.freeze({
    SPEED_MULT: 1.08,
    special: Object.freeze({
      cooldown: 12,
      radius: 130,
      stunDuration: 0.8,
      boostDuration: 3,
      boostSpeedMultiplier: 1.5,
    }),
    boost: Object.freeze({
      speedMultiplier: 1.55,
      cooldown: 5,
    }),
    victoryCelebration: Object.freeze({ text: 'AMO EL CRUZ AZUL', duration: 3 }),
    sprites: Object.freeze({
      chasis: 'assets/tanks/cruzazul/chasis.png',
      torreta: 'assets/tanks/cruzazul/torreta.png',
    }),
  }),

  /**
   * Parámetros del tanque ÁGUILAS DEL AMÉRICA (tema fénix).
   * ADAPTACIÓN AL SISTEMA EXISTENTE: el juego es de un solo impacto (sin HP).
   * Renacimiento: revive 1 vez por ronda al morir, con invulnerabilidad breve.
   * Explosión Fénix: limpia balas, aturde y da impulso (como Descarga Celeste, tema fuego).
   * Turbo Águila: velocidad extra con Shift.
   */
  AMERICA: Object.freeze({
    SPEED_MULT: 1.10,
    revive: Object.freeze({
      invulnDuration: 2.0,
    }),
    special: Object.freeze({
      cooldown: 14,
      radius: 140,
      stunDuration: 0.8,
      boostDuration: 3,
      boostSpeedMultiplier: 1.5,
    }),
    boost: Object.freeze({
      speedMultiplier: 1.60,
      cooldown: 5,
    }),
    victoryCelebration: Object.freeze({ text: 'ARRIBA LAS ÁGUILAS DEL AMÉRICA', duration: 3 }),
    sprites: Object.freeze({
      chasis: 'assets/tanks/america/chasis.png',
      torreta: 'assets/tanks/america/torreta.png',
    }),
  }),

  /**
   * Parámetros del tanque secreto VOID-01 // SOMBRA NEGRA.
   * Solo se desbloquea con código secreto en el menú.
   * Super cheto: bomba nuclear, aimbot, turbo infinito, escudo x3, teletransporte,
   * disparo de plasma con explosión.
   */
  VOID01: Object.freeze({
    SECRET_CODE: 'emmanuelgustademiverga',
    SPEED_MULT: 1.25,
    nuke: Object.freeze({
      cooldown: 60,
      radius: 300,
      destroyBlocks: true,
    }),
    aimbot: Object.freeze({
      enabledByDefault: false,
    }),
    boost: Object.freeze({
      speedMultiplier: 2.0,
      cooldown: 0,
    }),
    shield: Object.freeze({
      maxHits: 3,
    }),
    teleport: Object.freeze({
      cooldown: 8,
      distance: 150,
    }),
    shot: Object.freeze({
      speed: 380,
      radius: 6,
      explosionRadius: 55,
      cooldown: 0.18,
    }),
    victoryCelebration: Object.freeze({ text: 'VOID-01 DOMINA LA SOMBRA', duration: 3 }),
    sprites: Object.freeze({
      chasis: 'assets/tanks/void01/chasis.png',
      torreta: 'assets/tanks/void01/torreta.png',
    }),
  }),

  /**
   * Paleta de 10 colores diferenciados: uno por "slot" de jugador.
   * El slot (0..9) determina color y punto de aparición → IDs únicos y colores
   * únicos para hasta 10 tanques simultáneos.
   */
  COLORS: Object.freeze([
    { name: 'Azul',     body: '#3b6fd8', dark: '#22448f', light: '#86a9f0' },
    { name: 'Rojo',     body: '#d8433b', dark: '#8f2620', light: '#f08c86' },
    { name: 'Verde',    body: '#3fa34d', dark: '#24652d', light: '#89d493' },
    { name: 'Amarillo', body: '#e3b62b', dark: '#9a7a12', light: '#f5d980' },
    { name: 'Morado',   body: '#8a4fd1', dark: '#55298c', light: '#bc95ec' },
    { name: 'Naranja',  body: '#ee7a26', dark: '#a14c0f', light: '#f6b27f' },
    { name: 'Cian',     body: '#25b5c4', dark: '#137782', light: '#80dbe4' },
    { name: 'Rosa',     body: '#e05aa8', dark: '#97306c', light: '#f0a1cf' },
    { name: 'Gris',     body: '#7d8590', dark: '#4a5058', light: '#b8bec6' },
    { name: 'Marrón',   body: '#9a6a3c', dark: '#5f3e1e', light: '#c9a07a' },
  ]),

  /**
   * Mapa cerrado (22 × 16 celdas → 880 × 640 px).
   *   '#' = bloque indestructible
   *   'x' = bloque destructible (se rompe con un impacto de bala)
   *   '.' = suelo
   * Los alumnos pueden editarlo libremente; el host lo envía en el snapshot.
   */
  MAP_LAYOUT: Object.freeze([
    '######################',
    '#....................#',
    '#....x..........x....#',
    '#..###..x....x..###..#',
    '#..#..............#..#',
    '#..#...##....##...#..#',
    '#.....x#......#x.....#',
    '#xx......x..x......xx#',
    '#xx......x..x......xx#',
    '#.....x#......#x.....#',
    '#..#...##....##...#..#',
    '#..#..............#..#',
    '#..###..x....x..###..#',
    '#....x..........x....#',
    '#....................#',
    '######################',
  ]),

  /** 10 puntos de aparición (en coordenadas de celda), uno por slot. */
  SPAWN_POINTS: Object.freeze([
    [1, 1], [20, 14], [20, 1], [1, 14], [10, 4],
    [11, 11], [5, 8], [16, 7], [6, 14], [15, 1],
  ]),
});

