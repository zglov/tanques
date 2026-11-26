# TANKS! — Cómo publicar el multijugador en internet

Bro, tu juego **sí se puede publicar**, pero no en Cloudflare Pages tal cual: Pages solo sirve archivos estáticos y tu proyecto necesita `server.js` (Node) corriendo para el WebSocket.

Lo bueno: tu código ya está listo para la nube sin tocar la lógica del juego:
- `server.js` escucha en `process.env.PORT || 8000` y en `0.0.0.0`, que es justo lo que piden Render/Railway.
- El cliente (`TANKS/js/network.js`) arma el WebSocket con el mismo host/puerto de la página y cambia solo a `wss://` cuando la página abre en `https://`. O sea, en cuanto lo subas a una URL pública, el multijugador conecta solo.
- `package.json` ya trae `"start": "node server.js"` y la dependencia `ws`.

Verificado aquí: con `npm install` y `PORT=18099 npm start`, la raíz respondió **HTTP 200** y el título `TANKS! — Multijugador WebSocket`.

## Opción recomendada: Render (gratis)

1. Descomprime `TANKS_Multijugador.zip`.
2. Sube **el contenido** (no el zip) a un repo nuevo en GitHub. Que en la raíz del repo queden: `server.js`, `package.json`, `package-lock.json`, `README.md` y la carpeta `TANKS/`.
   - En GitHub web: *Add file → Upload files* → arrastras todo → *Commit changes*.
   - O por terminal: `git init && git add . && git commit -m "TANKS multijugador" && git branch -M main && git push -u origin main` (después de crear el repo vacío en GitHub).
3. En Render: *New → Web Service* → conecta ese repo.
4. Configura:
   - **Name:** algo corto, por ejemplo `tanks-multijugador` (ese nombre será parte de tu URL).
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance:** Free
   - **PORT:** no lo toques; Render lo asigna solo y tu `server.js` ya lo lee.
5. *Create Web Service* y espera el deploy. Cuando termine, tu URL será algo como `https://tanks-multijugador.onrender.com`.
6. Prueba real: abre esa URL en dos pestañas/dispositivos, crea la sala como **Local / Host** con 0 bots y entra como cliente con el mismo código de sala.

Notas de Render gratis: el servicio se **duerme tras ~15 min sin actividad** y la primera carga tarda en despertar; para la demo en clase, ábrelo unos minutos antes. Eso no cambia el código, solo espera unos segundos.

## Opción alterna: Railway

1. Sube el mismo repo a GitHub.
2. En Railway: *New Project → Deploy from GitHub repo* → elige el repo.
3. Railway detecta Node, corre `npm install` y `npm start` (tu `package.json` ya lo trae).
4. En *Settings → Networking* dale a *Generate Domain* para obtener la URL pública `https://...up.railway.app`.
5. Prueba igual con dos pestañas.

## Si quieres usar Cloudflare sin reescribir: Tunnel

Cloudflare **sí** puede exponer tu PC, pero con **Cloudflare Tunnel**, no con Pages:

1. Corre el juego en tu PC: `npm install && npm start` (queda en `http://localhost:8000`).
2. En otra terminal: `cloudflared tunnel --url http://localhost:8000`
3. Te dará una URL pública tipo `https://algo-aleatorio.trycloudflare.com`. Compártela; el WebSocket pasa por el túnel porque es el mismo host.
4. Limitaciones: la URL cambia cada vez que reinicias el túnel y tu PC debe seguir encendida con `npm start` y `cloudflared` corriendo. Sirve para demo rápida, no como entrega estable.

## Lo que NO recomiendo para tu entrega

Mover el relay a **Cloudflare Workers + Durable Objects**: sí se puede, pero es reescribir `network.js` y el servidor, no subir el zip. Para la clase, Render/Railway/Tunnel te dejan el juego intacto.

## Después de publicar

Pega la URL pública en el `README.md` (sección de acceso) y grábala en el video de evidencia: dos vistas con nombres distintos, código de sala, un disparo y una desconexión.

## Problemas comunes

- **Página carga pero el cliente no conecta:** revisa los logs del servicio en Render/Railway; debe decir algo como `[TANKS] Servidor listo`. Si dice que no encuentra `ws`, falta `npm install` en el build.
- **Error de puerto:** no fuerces el 8000 en la nube; deja que la plataforma asigne `PORT`. Tu código ya lo respeta.
- **"Ya hay un anfitrión en esa sala":** usa otro código de sala o espera a que salga el host anterior.
