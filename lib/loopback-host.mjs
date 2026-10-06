// The Host check both local servers (`preview` and `view`) make before answering. A website can
// point a name of its own at 127.0.0.1 (DNS rebinding) and read a loopback server through the
// browser; its requests carry that name in Host, so a server answers only the names it prints.

/**
 * isLoopbackHost(header, port, host = '127.0.0.1') -> boolean
 * True when a request's Host header names this server: `<host>:<port>`, and for 127.0.0.1 also
 * `localhost:<port>`, in any case. A browser leaves `:80` out on port 80, so there the bare name
 * passes too.
 */
export function isLoopbackHost(header, port, host = '127.0.0.1') {
  const asked = String(header ?? '').toLowerCase();
  const bound = String(host).toLowerCase();
  const names = bound === '127.0.0.1' ? [bound, 'localhost'] : [bound];
  return names.some((name) => asked === `${name}:${port}` || (Number(port) === 80 && asked === name));
}
