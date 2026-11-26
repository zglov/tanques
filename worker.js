/**
 * worker.js — TANKS! en Cloudflare Workers + Durable Objects.
 *
 * - Sirve los archivos estáticos de TANKS/ vía Workers Static Assets.
 * - Acepta WebSockets en /ws?room=<sala>&role=host|client&peerId=<id>&name=<nombre>
 * - Cada sala es un Durable Object (Room) con Hibernation API.
 * - Mismo protocolo que server.js (Node): JOIN, INPUT, STATE, LEAVE,
 *   HOST_LEFT, ROOM_FULL, ERROR, WELCOME.
 *
 * No se toca la lógica del juego: solo cambia el transporte.
 */

import { DurableObject } from "cloudflare:workers";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // WebSocket relay -> Durable Object por sala
    if (url.pathname === "/ws") {
      const upgradeHeader = request.headers.get("Upgrade");
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
        return new Response("Worker expected Upgrade: websocket", { status: 426 });
      }
      if (request.method !== "GET") {
        return new Response("Worker expected GET method", { status: 400 });
      }
      const roomId = (url.searchParams.get("room") || "sala-local").slice(0, 24);
      const stub = env.ROOM.getByName(roomId);
      return stub.fetch(request);
    }

    // Archivos estáticos (index.html, js/, css/)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Assets binding no configurado", { status: 500 });
  },
};

/**
 * Room — Durable Object por sala.
 * Usa Hibernation API: ctx.acceptWebSocket + serializeAttachment.
 */
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  _attachments() {
    // [{ws, att}] con att = {role, peerId, roomId, name}
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const att = ws.deserializeAttachment();
        if (att) out.push({ ws, att });
      } catch (_) {}
    }
    return out;
  }

  _findHost() {
    return this._attachments().find((x) => x.att.role === "host") || null;
  }

  _clients() {
    return this._attachments().filter((x) => x.att.role === "client");
  }

  _send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }

  async fetch(request) {
    const url = new URL(request.url);
    const roomId = (url.searchParams.get("room") || "sala-local").slice(0, 24);
    const role = url.searchParams.get("role") === "host" ? "host" : "client";
    let peerId = (url.searchParams.get("peerId") || "").slice(0, 32);
    const name = (url.searchParams.get("name") || "Jugador").slice(0, 14);
    const modelId = (url.searchParams.get("model") || "").slice(0, 20) || null;

    // Verificar host duplicado
    if (role === "host" && this._findHost()) {
      // No se puede hacer upgrade: responder con error JSON y cerrar.
      // El cliente detecta el mensaje 'error' y muestra aviso.
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ role: "rejected", peerId: "rejected", roomId, name });
      this._send(server, { type: "error", from: "server", data: { code: "host-exists", message: 'Ya hay un anfitrión en la sala "' + roomId + '". Elige otra sala.' } });
      // Cerrar tras enviar
      try { server.close(1008, "host exists"); } catch (_) {}
      return new Response(null, { status: 101, webSocket: client });
    }

    // ID único para clientes
    if (role === "client") {
      if (!peerId) peerId = "peer-" + crypto.randomUUID().slice(0, 8);
      const existing = new Set(this._clients().map((x) => x.att.peerId));
      let base = peerId;
      let n = 1;
      while (existing.has(peerId)) { peerId = base + "-" + (++n); }
    } else {
      peerId = "host";
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const att = { role, peerId, roomId, name, modelId };
    server.serializeAttachment(att);

    // Welcome para este peer
    this._send(server, { type: "welcome", from: "server", data: { peerId, roomId } });

    if (role === "host") {
      // Reenviar JOIN de clientes que ya estaban esperando
      for (const c of this._clients()) {
        this._send(server, { type: "join", from: c.att.peerId, data: { name: c.att.name || "Jugador", modelId: c.att.modelId || null } });
      }
    } else {
      // Avisar al host del nuevo cliente
      const host = this._findHost();
      if (host) {
        this._send(host.ws, { type: "join", from: peerId, data: { name, modelId } });
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(message); } catch (_) { return; }
    let att;
    try { att = ws.deserializeAttachment(); } catch (_) { return; }
    if (!att || att.role === "rejected") return;

    // El DO es la fuente de verdad del 'from'
    msg.from = att.peerId;

    if (att.role === "host") {
      if (msg.type === "state") {
        const json = JSON.stringify(msg);
        for (const c of this._clients()) {
          try { c.ws.send(json); } catch (_) {}
        }
      } else if (msg.type === "room-full") {
        const target = this._clients().find((x) => x.att.peerId === msg.to);
        if (target) this._send(target.ws, { type: "room-full", from: "host", data: {} });
      }
      return;
    }

    // Cliente -> host
    const host = this._findHost();
    if (msg.type === "join") {
      if (msg.data && msg.data.name) {
        att.name = String(msg.data.name).slice(0, 14);
      }
      if (msg.data && msg.data.modelId) {
        att.modelId = String(msg.data.modelId).slice(0, 20);
      }
      try { ws.serializeAttachment(att); } catch (_) {}
      if (host) this._send(host.ws, { type: "join", from: att.peerId, data: { name: att.name || "Jugador", modelId: att.modelId || null } });
    } else if (msg.type === "input") {
      if (host) this._send(host.ws, msg);
    } else if (msg.type === "skin") {
      if (host) this._send(host.ws, msg);
    } else if (msg.type === "leave") {
      if (host) this._send(host.ws, { type: "leave", from: att.peerId, data: {} });
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    let att;
    try { att = ws.deserializeAttachment(); } catch (_) { att = null; }
    // No llamamos ws.close() aquí: con Hibernation el runtime maneja el cierre.
    if (!att || att.role === "rejected") return;

    if (att.role === "host") {
      const json = JSON.stringify({ type: "host-left", from: "host", data: {} });
      for (const c of this._clients()) {
        try { c.ws.send(json); } catch (_) {}
        try { c.ws.close(1000, "host left"); } catch (_) {}
      }
    } else {
      const host = this._findHost();
      if (host) this._send(host.ws, { type: "leave", from: att.peerId, data: {} });
    }
  }

  async webSocketError(ws, error) {
    // Delegar al cierre para notificar al host / clientes
    await this.webSocketClose(ws, 1011, "error", false);
  }
}
