'use strict';
// Minimal SMTP client (no dependencies): implicit TLS on port 465, STARTTLS otherwise, AUTH PLAIN/LOGIN.
const net = require('net');
const tls = require('tls');
const os = require('os');
const crypto = require('crypto');

function session(socket) {
  let buf = '', waiting = null;
  const lines = [];
  const pump = () => {
    // A reply ends with a line "NNN text" (a hyphen after the code means more lines follow)
    const end = lines.findIndex(l => /^\d{3} /.test(l) || /^\d{3}$/.test(l));
    if (end < 0 || !waiting) return;
    const reply = lines.splice(0, end + 1);
    const w = waiting; waiting = null;
    w.resolve({ code: parseInt(reply[end].slice(0, 3)), text: reply.join('\n') });
  };
  const onData = d => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 2); }
    pump();
  };
  const onError = e => { if (waiting) { const w = waiting; waiting = null; w.reject(e); } };
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', () => onError(new Error('SMTP: conexión cerrada')));
  const read = () => new Promise((resolve, reject) => { waiting = { resolve, reject }; pump(); });
  const cmd = async (line, ok) => {
    if (line != null) socket.write(line + '\r\n');
    const r = await read();
    if (ok && !ok.includes(r.code)) throw new Error(`SMTP ${r.code}: ${r.text.split('\n').pop()}`);
    return r;
  };
  return { cmd, detach: () => { socket.off('data', onData); socket.off('error', onError); } };
}

const connect = (opts, secure) => new Promise((resolve, reject) => {
  const s = secure
    ? tls.connect({ host: opts.host, port: opts.port, servername: opts.host }, () => resolve(s))
    : net.connect({ host: opts.host, port: opts.port }, () => resolve(s));
  s.setTimeout(20000, () => s.destroy(new Error('SMTP: tiempo de espera agotado')));
  s.once('error', reject);
});

const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const encHeader = s => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const addr = s => (String(s).match(/<([^>]+)>/) || [null, s])[1].trim();

/**
 * Sends one message. opts: {host, port, secure, user, pass, from}; msg: {to, subject, text, html?}.
 * Resolves when the server accepts the message.
 */
async function sendMail(opts, msg) {
  const port = Number(opts.port) || 587;
  const implicitTls = opts.secure === true || port === 465;
  let socket = await connect({ host: opts.host, port }, implicitTls);
  let s = session(socket);
  try {
    await s.cmd(null, [220]);
    const host = os.hostname() || 'localhost';
    let ehlo = await s.cmd(`EHLO ${host}`, [250]);
    if (!implicitTls && /STARTTLS/i.test(ehlo.text)) {
      await s.cmd('STARTTLS', [220]);
      s.detach();
      socket = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket, servername: opts.host }, () => resolve(t));
        t.once('error', reject);
      });
      s = session(socket);
      ehlo = await s.cmd(`EHLO ${host}`, [250]);
    }
    if (opts.user) {
      if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo.text)) {
        await s.cmd('AUTH PLAIN ' + b64(`\0${opts.user}\0${opts.pass || ''}`), [235]);
      } else {
        await s.cmd('AUTH LOGIN', [334]);
        await s.cmd(b64(opts.user), [334]);
        await s.cmd(b64(opts.pass || ''), [235]);
      }
    }
    const to = [].concat(msg.to);
    await s.cmd(`MAIL FROM:<${addr(opts.from)}>`, [250]);
    for (const r of to) await s.cmd(`RCPT TO:<${addr(r)}>`, [250, 251]);
    await s.cmd('DATA', [354]);
    const boundary = 'b' + crypto.randomBytes(12).toString('hex');
    const headers = [
      `From: ${opts.from}`,
      `To: ${to.join(', ')}`,
      `Subject: ${encHeader(msg.subject || '')}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomBytes(16).toString('hex')}@${addr(opts.from).split('@')[1] || host}>`,
      'MIME-Version: 1.0',
    ];
    const part = (type, body) => [`Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '',
      b64(body).replace(/.{76}/g, '$&\r\n')].join('\r\n');
    const body = msg.html
      ? [`Content-Type: multipart/alternative; boundary="${boundary}"`, '',
         `--${boundary}`, part('text/plain', msg.text || ''), `--${boundary}`, part('text/html', msg.html), `--${boundary}--`].join('\r\n')
      : part('text/plain', msg.text || '');
    await s.cmd(headers.join('\r\n') + '\r\n' + body + '\r\n.', [250]);
    await s.cmd('QUIT').catch(() => {});
  } finally {
    socket.destroy();
  }
}

module.exports = { sendMail };
