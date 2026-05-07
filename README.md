# El Pajaro

Show de votacion entre cantantes emergentes **Cuba vs Puerto Rico**, transmitido simultaneamente en dos canales de Twitch. La votacion se cuenta en vivo desde los dos chats y se muestra en un overlay con un pajaro que tiene un bracket de eliminacion sobre las alas.

> Inspirado en el verso de Lola Rodriguez de Tio (1893):
> *"Cuba y Puerto Rico son de un pajaro las dos alas, reciben flores y balas sobre el mismo corazon."*

---

## Como funciona

- 16 cantantes (8 cubanos + 8 puertorriquenos), single-elim, 4 rondas, 15 matches.
- Round 1 (octofinales): cada match es estrictamente Cuba vs PR. 4 matches por ala.
- Rounds 2-4: el bracket manda. Cuartos / semis / final convergen al corazon del pajaro.
- Cada match tiene 3 fases: **PREVIEW** (clips de los dos cantantes) -> **VOTING** (chat vota `!1` o `!2`) -> **RESULT** (anuncio del ganador).
- Backend lee los DOS chats de Twitch via IRC. Cada voto se etiqueta con su origen (`cuba` o `pr`) y se desglosan barras separadas + total combinado.
- 1 voto por usuario por match (cross-channel — comparado por username, no IP).
- WebSocket pushea el estado a ambos OBS Browser Sources al mismo tiempo.

---

## Stack

- Node.js + Express + ws (WebSocket)
- Twitch IRC para leer chat (no requiere bits ni subs)
- HTML/CSS/JS vanilla. Sin build step. Sin frameworks.
- Persistencia local a `data/state.json` (Firebase opcional para cross-restart)

---

## Setup local (5 minutos)

```bash
git clone https://github.com/<TU-USUARIO>/elpajaro.git
cd elpajaro
npm install
cp .env.example .env
# editar .env y poner TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, HOST_PIN
npm start
```

Despues:

1. Abrir http://localhost:3000/host -> ingresar el `HOST_PIN`.
2. Tab **1 · Cantantes**: cargar el ejemplo (boton "Cargar 16 ejemplo") y subir foto + clip de cada uno.
3. Tab **2 · Emparejar**: sortear o ajustar manualmente los 8 octofinales. Guardar y construir bracket.
4. En el header, conectar **Twitch Cuba** y **Twitch PR** (cada streamer hace login con su cuenta).
5. Tab **3 · Show en vivo**: clickear el primer match -> PREVIEW -> Play clips -> ABRIR VOTACION -> CONFIRMAR GANADOR.

OBS Browser Source de los dos streamers apunta a:
```
http://<server>/show
```

---

## Gates antes de hostear publico

### 1. Crear app de Twitch (5 min)

- Ir a https://dev.twitch.tv/console/apps
- Click **Register Your Application**
- **Name**: `El Pajaro Stream` (o lo que quieras)
- **OAuth Redirect URLs** (registrar las DOS):
  - `http://localhost:3000/api/twitch/callback`
  - `https://elpajaro.stream/api/twitch/callback`
- **Category**: `Broadcaster Suite`
- **Client Type**: `Confidential`
- Guardar -> copiar **Client ID** y **New Secret**
- Pegarlos en `.env`

### 2. Crear repo en GitHub

```bash
gh auth login          # si no estas autenticado
gh repo create elpajaro --public --source . --remote origin --push
```

### 3. Render

- https://dashboard.render.com -> **New +** -> **Web Service**
- Conectar repo `elpajaro`
- **Build**: `npm install`
- **Start**: `node server.js`
- **Plan**: Free (validar) -> Starter ($7/mes) cuando lance oficial
- Environment Variables:
  - `TWITCH_CLIENT_ID`
  - `TWITCH_CLIENT_SECRET`
  - `HOST_PIN` (largo y unico, distinto al local)
  - `TWITCH_BOT_NICK` (cualquier string)
- Deploy. Render te da una URL `*.onrender.com`.

### 4. DNS Porkbun -> Render

Cuando el servicio Render este vivo:
- En Render: **Settings** -> **Custom Domain** -> agregar `elpajaro.stream` y `www.elpajaro.stream`
- Render te muestra un CNAME tipo `<service>.onrender.com`
- En Porkbun: borrar los dos registros actuales (ALIAS + CNAME que apuntan a `pixie.porkbun.com`) y poner:
  - `CNAME` `@` -> `<service>.onrender.com`
  - `CNAME` `www` -> `<service>.onrender.com`
  - (o lo que indique Render — puede ser ALIAS si Render lo permite)
- Esperar la propagacion (~5-30 min). Render emite el cert SSL solo.

### 5. Volver a Twitch dev portal

Verificar que `https://elpajaro.stream/api/twitch/callback` quedo registrado. Si no esta, agregalo y guardalo.

---

## Decisiones de producto (radical honestidad)

Antes de salir al aire pensa esto:

1. **Sesgo pro-PR**: el chat de Cuba sera estructuralmente mas chico (Internet caro/lento). Si querés justicia decidi por **% del chat de cada lado** en lugar de **suma absoluta**. La logica de votos esta en `lib/voting.js` — cambiar `decideMatch` para considerar promedios es 5 minutos.
2. **Sincronia de audio en los dos OBS**: hay drift de red ~100-300ms entre los dos streams cuando suena un clip. Aceptable para audiencias separadas, no perfecto.
3. **Politica**: Cuba + PR juntos puede ser politizado. Considerar un disclaimer en el show ("el pajaro vuela mas alto que las banderas") o arriesgarte a las opiniones.
4. **Waivers**: cada cantante deberia firmar un release simple cediendote el derecho a usar su voz/imagen para este stream. No firmas = no clip. Plantilla minima: nombre, fecha, link al stream, autorizacion no exclusiva por tiempo del show + 6 meses post.
5. **Anti-raid**: si alguien organiza un raid de 500 viewers a un canal solo para inflar votos a un lado, no hay defensa perfecta. Mitigacion: ignorar votos de cuentas creadas hace menos de N dias (requiere un hop a la API de Twitch — no esta implementado todavia).

---

## Estructura del proyecto

```
elpajaro/
├── server.js                    # Express + WS + cablea todo
├── lib/
│   ├── state.js                 # Estado central + persistencia disco
│   ├── ws-broadcast.js          # Pub/sub minimo
│   ├── host-auth.js             # PIN gate + tokens en memoria
│   ├── bracket.js               # Logica del bracket (16->8->4->2->1)
│   ├── voting.js                # Votos cross-channel + dedup
│   ├── twitch-irc.js            # Cliente IRC factory (1 por canal)
│   └── twitch-oauth.js          # OAuth con state=cuba|pr
├── public/
│   ├── show.html                # Overlay para OBS Browser Source
│   ├── host.html                # Panel del host
│   ├── css/{show,host}.css
│   ├── js/{show,host}.js
│   └── uploads/{contestants,clips}/   # fotos + clips subidos
├── data/
│   ├── contestants.example.json # 16 cantantes dummy para testear
│   └── state.json               # estado persistido (creado al primer save)
└── .env.example
```

---

## Troubleshooting

**El boton de Twitch abre el popup pero no conecta.**
Chequear que las redirect URLs en dev.twitch.tv/console/apps estan EXACTAS — `http://localhost:3000/api/twitch/callback` (no `https`, no trailing slash).

**Los votos del chat no se cuentan.**
Mirar la consola del server. Tiene que decir `[IRC:cuba] conectado a #...` y `[IRC:pr] conectado a #...`. Si no, el OAuth fallo o el chat:read no esta autorizado.

**OBS Browser Source no actualiza despues de un deploy.**
Click derecho en la fuente -> Refresh cache. El server ya manda `Cache-Control: no-store`, pero a veces OBS lo ignora la primera vez.

**El pajaro se ve cortado en la pantalla.**
Asegurate de que la Browser Source este en 1920x1080 (o lo que mande la escena). El SVG es responsive, pero el layout se calibro para 16:9.
