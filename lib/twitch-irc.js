/**
 * Cliente IRC de Twitch — multi-canal.
 *
 * Diferencia con TortillaTV/donations.js: aca necesitamos DOS conexiones
 * simultaneas (chat cubano + chat puertorriqueno). Por eso es una factory
 * que devuelve una instancia por canal en vez de modulo singleton.
 *
 * Cada instancia conoce su `origin` ('cuba' | 'pr') y lo agrega a cada
 * mensaje que entrega al listener. Asi el voting.js sabe de que canal
 * vino el voto sin tener que pegar dos sockets distintos.
 */

const WebSocket = require('ws');

const RECONNECT_DELAY_MS = 5_000;
const PING_REPLY = 'PONG :tmi.twitch.tv\r\n';
const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';

/**
 * Crea un cliente IRC para un canal Twitch.
 *
 * @param {Object} opts
 * @param {string} opts.origin       — 'cuba' o 'pr'
 * @param {string} opts.botNick      — nick visible (cualquier string ascii)
 * @param {Function} opts.onMessage  — (username, message, origin) => void
 * @param {Function} [opts.onStatus] — (status: { connected: boolean, login }) => void
 * @returns {Object} { connect, disconnect, isConnected, getLogin }
 */
function createIrcClient({ origin, botNick, onMessage, onStatus }) {
  let ws = null;
  let accessToken = null;
  let broadcasterLogin = null;
  let connected = false;
  let reconnectTimer = null;
  let manualDisconnect = false;

  function emitStatus() {
    if (onStatus) {
      try { onStatus({ connected, login: broadcasterLogin, origin }); }
      catch (e) { console.error(`[IRC:${origin}] onStatus error:`, e.message); }
    }
  }

  function clearReconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  function scheduleReconnect() {
    if (manualDisconnect) return;
    clearReconnect();
    reconnectTimer = setTimeout(() => {
      if (accessToken && broadcasterLogin) connect(accessToken, broadcasterLogin);
    }, RECONNECT_DELAY_MS);
  }

  /**
   * Conecta (o reconecta con credenciales nuevas). Si ya hay un socket
   * abierto, lo cierra primero. Llamar despues de cada OAuth callback.
   */
  function connect(token, login) {
    if (!token || !login) {
      console.warn(`[IRC:${origin}] connect llamado sin token o login`);
      return;
    }
    accessToken = token;
    broadcasterLogin = String(login).toLowerCase();
    manualDisconnect = false;

    if (ws) { try { ws.close(); } catch {} }

    console.log(`[IRC:${origin}] conectando a #${broadcasterLogin}...`);
    ws = new WebSocket(IRC_URL);

    ws.on('open', () => {
      try {
        ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands\r\n');
        ws.send(`PASS oauth:${accessToken}\r\n`);
        ws.send(`NICK ${botNick}\r\n`);
        ws.send(`JOIN #${broadcasterLogin}\r\n`);
      } catch (e) {
        console.error(`[IRC:${origin}] handshake error:`, e.message);
      }
    });

    ws.on('message', (raw) => {
      const text = raw.toString();

      // Mantener viva la conexion.
      if (text.startsWith('PING')) {
        try { ws.send(PING_REPLY); } catch {}
        return;
      }

      // El "JOIN exitoso" no llega como evento estandar; usamos el primer
      // 366 (End of /NAMES list) como senal de que estamos dentro del canal.
      if (!connected && text.includes(' 366 ')) {
        connected = true;
        console.log(`[IRC:${origin}] conectado a #${broadcasterLogin}`);
        emitStatus();
      }

      // PRIVMSG = mensaje de chat. Parser inline para evitar dep extra.
      if (text.includes('PRIVMSG')) {
        // Twitch puede mandar varios mensajes en un solo frame separados por \r\n.
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
          const m = line.match(/:([^!]+)!\w+@\w+\.tmi\.twitch\.tv PRIVMSG #(\w+) :(.+)/);
          if (!m) continue;
          const username = m[1];
          const message  = m[3].trim();
          if (onMessage) {
            try { onMessage(username, message, origin); }
            catch (e) { console.error(`[IRC:${origin}] onMessage error:`, e.message); }
          }
        }
      }
    });

    ws.on('error', (e) => {
      console.error(`[IRC:${origin}] error:`, e.message);
    });

    ws.on('close', () => {
      console.log(`[IRC:${origin}] cerrado`);
      const wasConnected = connected;
      connected = false;
      ws = null;
      if (wasConnected) emitStatus();
      scheduleReconnect();
    });
  }

  function disconnect() {
    manualDisconnect = true;
    clearReconnect();
    if (ws) { try { ws.close(); } catch {} ws = null; }
    connected = false;
    emitStatus();
  }

  function isConnected() { return connected; }
  function getLogin() { return broadcasterLogin; }

  return { connect, disconnect, isConnected, getLogin };
}

module.exports = { createIrcClient };
