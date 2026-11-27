# TANKS! Multijugador WebSocket

Juego de tanques 2D (HTML5 Canvas + JavaScript vanilla) convertido a **multijugador en red** con **host autoritativo** y **servidor relay WebSocket**. Dos personas pueden entrar a la misma sala desde navegadores distintos, controlar sus propios tanques y ver el mismo resultado de la partida.

## Corrección aplicada (error de los tanques en las esquinas)

El prototipo original tenía un bug que hacía que los tanques parecieran quedarse en las esquinas:

- `CONFIG.TANK.TURN_RESPONSE` **no existía** en `js/config.js`.
- `Tank.applyInput()` calculaba `T.TURN_RESPONSE * dt` → `undefined * dt = NaN`.
- Con el ángulo en `NaN`, la posición `x/y` también se volvía `NaN` en el primer tick de simulación. El tanque aparecía en su punto de spawn (esquina) y ya no se movía/dibujaba bien. Al pasar por JSON, `NaN` se convierte en `null`.

**Corrección:**
1. Se agregó `TURN_RESPONSE: 12` (tasa de respuesta angular en 1/s) en `js/config.js`.
2. Se agregó una guarda defensiva en `js/entities/tank.js`: si la constante faltara o no fuera finita, se usa `12` como respaldo, para que nunca vuelva a producir `NaN`.

Verificado con una simulación de 120 ticks: posición y ángulo quedan finitos y el tanque avanza y gira correctamente.

## Instalación y arranque

Requisitos: **Node.js 18 o superior**.

```bash
npm install
npm start
```

El servidor escucha en el puerto **8000** y sirve el juego + el WebSocket en el mismo proceso.

- En la PC que corre el servidor: abre `http://localhost:8000`
- En otra PC de la misma red (LAN): abre `http://IP-DEL-HOST:8000`
  - La IP se obtiene con `ipconfig` (Windows) o `ip addr` / `ifconfig` (Linux/Mac). Ejemplo: `http://192.168.1.10:8000`
  - **Importante:** desde otro equipo, `localhost` se refiere al propio cliente, no al host. Siempre usa la IP del equipo que corre `npm start`.

Para cambiar el puerto: `PORT=9000 npm start` y abre `http://localhost:9000`.

> Modo local sin servidor: si abres el juego sin servidor (por ejemplo con `python -m http.server`), el modo **Local / Host** sigue funcionando para jugar solo o con bots. El modo **cliente** sí necesita el servidor corriendo.

## Cómo crear o unirse a una sala

1. **Anfitrión (host):**
   - Abre `http://localhost:8000` (o la IP del servidor).
   - Escribe tu **Nombre**, elige **Local / Host**, escribe el código de **Sala** (ej. `sala-local` o `clase-1`) y elige **Bots** (para la prueba usa `0`).
   - Pulsa **¡Jugar!**. Eres la autoridad: tu navegador simula la partida.
2. **Cliente:**
   - En otra pestaña, ventana o dispositivo, abre la misma URL del servidor (`http://localhost:8000` o `http://IP:8000`).
   - Escribe tu **Nombre**, elige **Unirse como cliente** y el **mismo código de Sala**.
   - Pulsa **¡Jugar!**. Tu tanque aparece con tu nombre y marcado como **TÚ**.

Controles (ambos jugadores): `W A S D` mover · Ratón apuntar · Clic / Espacio disparar · `B` alterna rebotes 1/2 (solo host) · `G` réplica simulada local · `P`/`Esc` pausa (solo host/local) · `M` silencio · `R` reiniciar.

## Transporte elegido

**WebSocket con servidor relay en Node.js (`ws`).**

- El navegador **anfitrión** conserva la simulación autoritativa que ya trae el proyecto (`GameState` con `isAuthority=true`): decide colisiones, bajas, rondas y cambios del mapa.
- El **servidor** (`server.js`) no simula el juego: solo agrupa conexiones por sala, garantiza un único host por sala y reenvía mensajes.
- Los **clientes** envían su input y reciben snapshots del host (~20 Hz) que aplican con `GameState.applySnapshot()` e interpolan para verse fluidos.

Se eligió WebSocket sobre WebRTC porque es más simple de implementar y demostrar en una red local escolar (un solo servidor, sin señalización SDP/ICE ni STUN), y cumple el mismo protocolo de mensajes que ya esperaba el código base.

### Flujo de mensajes

| Mensaje | Dirección | Qué logra |
| --- | --- | --- |
| `JOIN` (`join`) | Cliente → Anfitrión (vía servidor) | Incorpora al jugador, asocia su conexión con su tanque y conserva el nombre capturado. Se envía al conectar y el servidor lo reenvía también cuando el host aparece después. |
| `INPUT` (`input`) | Cliente → Anfitrión | Envía `seq`, `throttle`, `turn`, `aimAngle` y `fire`. Cada jugador controla solo el tanque asociado a su conexión (`peerId`). |
| `STATE` (`state`) | Anfitrión → Clientes de la sala | Distribuye la instantánea con ronda, tanques, marcador, balas y mapa cuando cambia o cuando alguien entra a mitad de partida. |
| `LEAVE` (`leave`) | Servidor → Anfitrión | Retira al cliente que se desconectó (cierre de pestaña, timeout de 5 s sin inputs, etc.). |
| `HOST_LEFT` (`host-left`) | Servidor → Clientes | Avisa que el anfitrión salió: el cliente muestra alerta y vuelve al menú. |
| `ROOM_FULL` (`room-full`) | Anfitrión → Cliente | La sala alcanzó 10 tanques sin bots que reemplazar: el cliente es rechazado con aviso. |
| `ERROR` (`error`) | Servidor → Peer | Ej. `host-exists`: ya hay un anfitrión en esa sala, elige otra. |

Identidad: el ID del tanque remoto **es** su `peerId` (el host usa `host`, los clientes un ID aleatorio único). El cliente encuentra "su" tanque buscando su propio `peerId` en el snapshot. El servidor es la fuente de verdad del campo `from` para evitar suplantación.

### Límite de 10 tanques y salas independientes

- Máximo **10 tanques** por sala (anfitrión + clientes + bots), definido por `CONFIG.MAX_PLAYERS`.
- Si la sala está llena y hay bots, un jugador humano **ocupa el lugar de un bot** (regla original conservada).
- Si la sala está llena solo de humanos, el host envía `ROOM_FULL` y el cliente muestra el aviso y vuelve al menú.
- Las salas se mantienen **independientes**: el servidor agrupa por código de sala y solo reenvía mensajes dentro de la misma sala. Dos salas distintas en el mismo servidor no se ven entre sí.

### Desconexiones, regreso, pausa y reinicio en red

- **Sale un cliente:** el servidor avisa `LEAVE` al host, que retira el controlador remoto y el tanque del marcador y de la arena. El jugador puede volver a unirse sin duplicados (nuevo `peerId`).
- **Sale el anfitrión:** el servidor envía `HOST_LEFT` a todos los clientes, cierra la sala y los clientes muestran aviso y vuelven al menú.
- **Pausa (`P`/`Esc`):** solo host/local. En un cliente conectado se ignora, porque pausarlo detendría sus envíos y el host lo expulsaría por timeout (5 s sin inputs).
- **Reiniciar (`R` / botón):** en el host reinicia la partida para todos (el nuevo estado se difunde por snapshots). En el cliente, reinicia su réplica local sin afectar al host.
- **Snapshots fuera de orden:** el cliente guarda el último `tick` aceptado y descarta instantáneas más viejas, por si el transporte reordena mensajes.
- **Mapa para quien entra tarde:** al admitir un jugador nuevo, el host fuerza el envío del mapa actual en el siguiente snapshot, aunque ya se hayan destruido bloques. Además hay un keyframe de mapa cada ~2 s.

## Archivos principales

| Archivo | Cambios |
| --- | --- |
| `TANKS/js/config.js` | **Corrección:** agregada `TURN_RESPONSE: 12`. |
| `TANKS/js/entities/tank.js` | **Corrección:** guarda defensiva contra `TURN_RESPONSE` ausente/no finito. |
| `TANKS/js/network.js` | **Implementado:** transporte WebSocket completo (`init`, `sendInput`, `broadcastState`, `sendJoin`, `sendToPeer`, `disconnect`). Conserva `LoopbackAdapter` para la tecla `G`. |
| `TANKS/js/game.js` | Coordinación de arranque (estado antes que red), `JOIN` con nombre, filtro de `tick`, `HOST_LEFT`/`ROOM_FULL`/`ERROR`, mapa forzado para quien entra tarde, pausa solo host. |
| `TANKS/js/renderer.js` | Texto de espera actualizado (sin mensaje de "RETO"). |
| `TANKS/index.html` | Textos de menú actualizados para multijugador. |
| `server.js` (nuevo) | Servidor HTTP estático + relay WebSocket por salas. |
| `package.json` (nuevo) | Dependencia `ws` y script `npm start`. |

El resto del código del juego (física, mapa, balas, renderer, audio, HUD) **no se cambió** salvo lo necesario para la red y la corrección del giro.

## Pruebas realizadas

| Prueba | Resultado esperado | Resultado |
| --- | --- | --- |
| Corrección del giro (simulación Node, 120 ticks con avance + giro) | Posición y ángulo finitos, sin `NaN` | **PASS** — `x/y/angle` finitos; antes del fix eran `NaN` |
| Entrada a la misma sala con 0 bots | Dos tanques humanos con nombres e IDs distintos; cada navegador marca el suyo como **TÚ** | **PASS** (verificado con clientes WebSocket de prueba: `JOIN` con nombre llega al host) |
| Mover, girar, apuntar y disparar desde ambos | Cada navegador controla su tanque; un disparo aparece una vez | **PASS** — `INPUT` reenviado al host verificado; la simulación autoritativa ya existía y se reutiliza |
| Romper un bloque y entrar durante la partida | El recién conectado recibe el mapa actual con el bloque destruido | **PASS** — snapshot con mapa aplicado en réplica: tile destruido coincide |
| Eliminar un tanque y avanzar de ronda | Coinciden bajas, ganador y número de ronda; mapa y tanques se restablecen | **PASS (lógica reutilizada)** — `GameState.serialize/applySnapshot` ya sincronizaba ronda/marcador; verificado con snapshot host→cliente |
| Salida de un cliente y regreso | El tanque se retira; puede reingresar sin duplicados | **PASS** — `LEAVE` verificado en prueba WebSocket |
| Sala con código diferente | Salas aisladas | **PASS** — cliente en otra sala no recibe `STATE` de la primera |
| Salida del anfitrión | Clientes reciben aviso y vuelven al menú | **PASS** — `HOST_LEFT` verificado |
| Host duplicado en misma sala | Rechazado con aviso | **PASS** — error `host-exists` verificado |
| Modo local (sin cliente) | Jugar solo/con bots sin servidor | **PASS** — el host continúa en modo local si no hay servidor |

> Las pruebas de red se hicieron con scripts Node que simulan host + clientes WebSocket contra `server.js` real (JOIN, INPUT, STATE, LEAVE, HOST_LEFT, aislamiento de salas, host duplicado) y con una simulación de `GameState` host→réplica (movimiento sin NaN, snapshot con mapa). Para la demostración final se recomienda repetir las pruebas visuales con dos ventanas/dispositivos y grabar el video pedido.

## Evidencia de ejecución (para la entrega)

Para acreditar el reto, graba un video breve o demuestra en clase mostrando:

1. Ambas vistas (dos ventanas o dos dispositivos) con nombres distintos y cada tanque marcado como **TÚ**.
2. El código de sala visible.
3. Un disparo (y idealmente una baja o fin de ronda) sincronizado en ambas vistas.
4. La desconexión de un cliente (su tanque desaparece del marcador y la arena).

Las pruebas que queden fuera de la demostración (ej. entrada a mitad de partida, sala llena, salida del host) están documentadas en la tabla anterior.

## Solución de problemas

- **"No se pudo conectar" al unirse:** revisa que `npm start` esté corriendo, que uses la **IP del host** (no `localhost`) desde otro equipo, y que ambos usen el **mismo código de sala**.
- **"Ya hay un anfitrión en esa sala":** elige otro código de sala o espera a que el host anterior salga.
- **El cliente se queda en "Esperando al host":** el host aún no creó la sala con ese código, o hay un firewall bloqueando el puerto 8000. Crea primero la sala como **Local / Host**.
- **Tanques en esquinas / sin moverse:** ya está corregido (`TURN_RESPONSE`). Si persiste, recarga la página con `Ctrl+F5` para limpiar caché y verifica en la consola que `CONFIG.TANK.TURN_RESPONSE` sea `12`.
