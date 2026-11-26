'use strict';
/**
 * server.js — Servidor TANKS! (archivos estáticos + relay WebSocket por salas).
 *
 * - Sirve la carpeta TANKS/ en http://localhost:8000
 * - Acepta WebSockets en /ws?room=<sala>&role=host|client&peerId=<id>&name=<nombre>
 * - Agrupa por sala: un solo host por sala; los clientes se unen a esa sala.
 * - Reenvía: INPUT/JOIN/LEAVE del cliente -> host; STATE del host -> clientes.
 * - Si el host se desconecta, avisa a los clientes con 'host-left' y cierra la sala.
 * - Si un cliente se desconecta, avisa al host con 'leave'.
 *
 * Uso:
 *   npm install
 *   npm start
 *   # Host: abre http://localhost:8000 y elige Local / Host con la sala
 *   # Cliente (misma PC): abre otra pestaña http://localhost:8000, elige cliente y misma sala
 *   # Cliente (otra PC en la LAN): abre http://IP-DEL-HOST:8000 (no localhost)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '8000', 10);
const ROOT = path.join(__dirname, 'TANKS');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404 Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server, path: '/ws' });

/** roomId -> { host: ws|null, clients: Map<peerId, ws>, names: Map<peerId, string>, models: Map<peerId, string> } */
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, { host: null, clients: new Map(), names: new Map(), models: new Map() });
  return rooms.get(roomId);
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws, req) => {
  const u = new URL(req.url, 'http://x');
  const roomId = (u.searchParams.get('room') || 'sala-local').slice(0, 24);
  const role = u.searchParams.get('role') === 'host' ? 'host' : 'client';
  let peerId = (u.searchParams.get('peerId') || '').slice(0, 32);
  const name = (u.searchParams.get('name') || 'Jugador').slice(0, 14);
  const modelId = (u.searchParams.get('model') || '').slice(0, 20) || null;

  const room = getRoom(roomId);

  if (role === 'host') {
    if (room.host && room.host.readyState === room.host.OPEN) {
      send(ws, { type: 'error', from: 'server', data: { code: 'host-exists', message: 'Ya hay un anfitrión en la sala "' + roomId + '". Elige otra sala.' } });
      ws.close();
      return;
    }
    room.host = ws;
    ws._role = 'host';
    ws._peerId = 'host';
    ws._roomId = roomId;
    console.log('[TANKS] Host en sala "' + roomId + '" (' + room.clients.size + ' clientes esperando)');
    send(ws, { type: 'welcome', from: 'server', data: { peerId: 'host', roomId } });
    // Avisar a clientes que ya estaban esperando (si se conectaron antes que el host)
    for (const [cid, cws] of room.clients) {
      send(cws, { type: 'welcome', from: 'server', data: { peerId: cid, roomId } });
      // Reenviar JOIN al host para que cree el tanque de cada cliente en espera
      send(ws, { type: 'join', from: cid, data: { name: room.names.get(cid) || 'Jugador', modelId: room.models.get(cid) || null } });
    }
  } else {
    if (!peerId) peerId = 'peer-' + Math.random().toString(36).slice(2, 8);
    // Evitar duplicados: si ya existe, generar otro
    let base = peerId;
    let n = 1;
    while (room.clients.has(peerId)) { peerId = base + '-' + (++n); }
    ws._role = 'client';
    ws._peerId = peerId;
    ws._roomId = roomId;
    room.clients.set(peerId, ws);
    room.names.set(peerId, name);
    room.models.set(peerId, modelId);
    console.log('[TANKS] Cliente ' + peerId + ' (' + name + ') en sala "' + roomId + '"');
    send(ws, { type: 'welcome', from: 'server', data: { peerId, roomId } });
    // Si ya hay host, avisarle del nuevo cliente para que cree su tanque
    if (room.host) {
      send(room.host, { type: 'join', from: peerId, data: { name, modelId } });
    }
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    const r = rooms.get(ws._roomId);
    if (!r) return;

    // El servidor es la fuente de verdad del 'from' para evitar suplantación.
    const fromId = ws._peerId;
    msg.from = fromId;

    if (ws._role === 'host') {
      if (msg.type === 'state') {
        // Difundir a todos los clientes de la sala
        const json = JSON.stringify(msg);
        for (const cws of r.clients.values()) {
          if (cws.readyState === cws.OPEN) cws.send(json);
        }
      } else if (msg.type === 'room-full') {
        // El host avisa a un cliente específico que la sala está llena
        const target = r.clients.get(msg.to);
        if (target) send(target, { type: 'room-full', from: 'host', data: {} });
      }
      return;
    }

    // Cliente -> host
    if (msg.type === 'join') {
      // Actualizar nombre y modelo si vienen en el mensaje
      if (msg.data && msg.data.name) r.names.set(fromId, String(msg.data.name).slice(0, 14));
      if (msg.data && msg.data.modelId) r.models.set(fromId, String(msg.data.modelId).slice(0, 20));
      if (r.host) send(r.host, { type: 'join', from: fromId, data: { name: r.names.get(fromId) || name, modelId: r.models.get(fromId) || null } });
    } else if (msg.type === 'input') {
      if (r.host) send(r.host, msg);
    } else if (msg.type === 'skin') {
      if (r.host) send(r.host, msg);
    } else if (msg.type === 'leave') {
      if (r.host) send(r.host, { type: 'leave', from: fromId, data: {} });
    }
  });

  ws.on('close', () => {
    const r = rooms.get(ws._roomId);
    if (!r) return;
    if (ws._role === 'host') {
      console.log('[TANKS] Host salió de sala "' + ws._roomId + '"');
      const json = JSON.stringify({ type: 'host-left', from: 'host', data: {} });
      for (const cws of r.clients.values()) {
        if (cws.readyState === cws.OPEN) cws.send(json);
      }
      // Cerrar clientes y borrar sala
      for (const cws of r.clients.values()) { try { cws.close(); } catch (_) {} }
      rooms.delete(ws._roomId);
    } else {
      console.log('[TANKS] Cliente ' + ws._peerId + ' salió de sala "' + ws._roomId + '"');
      r.clients.delete(ws._peerId);
      r.names.delete(ws._peerId);
      r.models.delete(ws._peerId);
      if (r.host) send(r.host, { type: 'leave', from: ws._peerId, data: {} });
      // Si no queda nadie, limpiar
      if (!r.host && r.clients.size === 0) rooms.delete(ws._roomId);
    }
  });

  ws.on('error', () => { try { ws.close(); } catch (_) {} });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[TANKS] Servidor listo en http://localhost:' + PORT);
  console.log('[TANKS] En otra PC de la LAN abre http://TU-IP:' + PORT);
  console.log('[TANKS] WebSocket en ws://localhost:' + PORT + '/ws');
});
