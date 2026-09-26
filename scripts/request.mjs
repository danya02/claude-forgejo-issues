// A dependency-free HTTP client that respects the proxy environment.
//
// Node's built-in fetch ignores HTTP_PROXY/HTTPS_PROXY unless the process was
// started with NODE_USE_ENV_PROXY=1 -- and that variable is read at startup,
// so a script cannot set it for itself, while putting `VAR=1 node ...` in a
// hook command breaks on Windows. Behind a proxy the request then goes out
// direct and an API-looking failure can be a CDN edge, not the API. Same
// transport approach as the quota plugin's client; this one carries a method
// and a body, which is what the write endpoints need.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns";

// getaddrinfo with AF_UNSPEC can be pathologically slow on some systems --
// measured on this machine: ~5 s for a name with a single A record, vs ~8 ms
// when asking for AF_INET directly (most likely a quirk of this network's
// DNS/IPv6 handling, not of Node or the forge -- re-measure before assuming
// it applies elsewhere). Node's default lookup uses AF_UNSPEC, so every
// request would pay that stall (or hit the request timeout). The fix asks
// for IPv4 first and falls back to IPv6 only when there is no A record;
// both single calls are always fast, and IPv6-only hosts still work.
function v4FirstLookup(hostname, options, callback) {
  dnsLookup(hostname, { ...options, family: 4 }, (err, address, family) => {
    if (!err) {
      callback(null, address, family);
      return;
    }
    dnsLookup(hostname, { ...options, family: 6 }, (err6, address6, family6) => {
      callback(err6, address6, family6);
    });
  });
}

// Returns { status, headers, body } -- rejects only on transport failure, so
// a 401 or a 500 is a normal resolution the caller decides about. `body` is
// a string or null, sent as-is: the caller owns the content type.
export async function request(method, rawUrl, { headers = {}, body = null, timeoutMs = 5000 } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`internal: cannot parse request URL ${JSON.stringify(rawUrl)}`);
  }
  const proxy = proxyFor(url);
  const describe = `${method} ${rawUrl}${proxy ? ` via ${proxy.host}` : " direct"}`;
  const finalHeaders = { accept: "application/json", ...headers };
  if (body !== null) finalHeaders["content-length"] = String(Buffer.byteLength(body));
  if (!proxy) return await plainRequest(url, method, finalHeaders, body, timeoutMs, describe);
  if (url.protocol === "http:") {
    return await proxiedPlainRequest(url, proxy, method, finalHeaders, body, timeoutMs, describe);
  }
  return await tunnelledRequest(url, proxy, method, finalHeaders, body, timeoutMs, describe);
}

// Picks the proxy for url from the environment, or null for direct.
// Lowercase wins over uppercase (the curl convention); NO_PROXY always wins
// over any proxy setting. A value we cannot parse counts as no proxy: a
// half-configured proxy must not turn every request into a connect error.
export function proxyFor(url, env = process.env) {
  if (noProxyMatches(url.hostname, env)) return null;
  const raw = (url.protocol === "https:"
    ? env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY
    : env.http_proxy || env.HTTP_PROXY) || "";
  if (!raw) return null;
  try {
    const proxy = new URL(raw.includes("://") ? raw : `http://${raw}`);
    if (proxy.protocol !== "http:" && proxy.protocol !== "https:") return null;
    if (!proxy.hostname) return null;
    return proxy;
  } catch {
    return null;
  }
}

// no_proxy entries are host names with optional leading dots; matching is by
// host suffix. Ports in entries are ignored, which can only over-bypass
// (toward direct, the safe direction), never route a bypassed host through
// the proxy.
function noProxyMatches(hostname, env) {
  const list = env.no_proxy ?? env.NO_PROXY;
  if (!list) return false;
  const host = hostname.toLowerCase();
  for (const entry of String(list).split(",")) {
    const pattern = entry.trim().toLowerCase().replace(/^\./, "");
    if (!pattern) continue;
    if (pattern === "*") return true;
    if (host === pattern) return true;
    if (host.endsWith(`.${pattern}`)) return true;
  }
  return false;
}

function plainRequest(url, method, headers, body, timeoutMs, describe) {
  const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
    method,
    headers,
    lookup: v4FirstLookup,
  });
  return collect(req, body, timeoutMs, describe);
}

// An http URL fetched through a proxy goes out as an absolute-URI request
// line addressed to the proxy -- the one form of proxying plain HTTP has.
function proxiedPlainRequest(url, proxy, method, headers, body, timeoutMs, describe) {
  const req = httpRequest({
    protocol: "http:",
    hostname: proxy.hostname,
    port: Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80),
    method,
    path: `${url.protocol}//${url.host}${url.pathname}${url.search}`,
    headers: withProxyAuth(proxy, { ...headers, host: url.host }),
    lookup: v4FirstLookup,
  });
  return collect(req, body, timeoutMs, describe);
}

// An https URL is sent through the proxy as raw TLS inside a CONNECT tunnel:
// the proxy sees only host:port, the payload stays opaque to it. The TLS
// layer is opened by httpsRequest over the tunnelled socket, with servername
// set so SNI still names the target host rather than the proxy.
function tunnelledRequest(url, proxy, method, headers, body, timeoutMs, describe) {
  return openTunnel(url, proxy, timeoutMs).then((socket) => {
    const req = httpsRequest({
      method,
      headers,
      host: url.hostname,
      port: Number(url.port) || 443,
      path: `${url.pathname}${url.search}`,
      servername: url.hostname,
      agent: false,
      createConnection: () => socket,
    });
    return collect(req, body, timeoutMs, describe);
  });
}

async function openTunnel(url, proxy, timeoutMs) {
  const port = Number(url.port) || 443;
  const target = `${url.hostname}:${port}`;
  return await new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: proxy.hostname,
      port: Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80),
      method: "CONNECT",
      path: target,
      headers: withProxyAuth(proxy, { host: target }),
      lookup: v4FirstLookup,
    });
    const timer = setTimeout(() => {
      req.destroy(new Error(`${describe} (proxy CONNECT): timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref();
    req.once("connect", (res, socket) => {
      clearTimeout(timer);
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`${describe}: proxy CONNECT returned ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });
    req.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

// Proxy credentials arrive URL-style in the proxy variable; they move into a
// header and are never logged -- describe strings carry proxy.host only.
function withProxyAuth(proxy, headers) {
  if (proxy.username || proxy.password) {
    const basic = Buffer.from(
      `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
    ).toString("base64");
    return { ...headers, "proxy-authorization": `Basic ${basic}` };
  }
  return headers;
}

// Drives one request to completion: writes the body, bounds the exchange
// with a single unref'd timer (a stuck request must never hold the process
// open past its other work), and caps the response at 1 MB -- an issues list
// that large means something is wrong and stopping is the honest outcome.
// Resolves { status, headers, body }; the describe string is already in
// every error, so failures read "GET https://... via proxy:3128: timed out".
const MAX_BODY = 1_000_000;

function collect(req, body, timeoutMs, describe) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy(new Error(`${describe}: timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref();
    const fail = (err) => {
      clearTimeout(timer);
      reject(err);
    };
    req.once("response", (res) => {
      res.setEncoding("utf8");
      let text = "";
      res.on("data", (chunk) => {
        text += chunk;
        if (text.length > MAX_BODY) {
          req.destroy();
          reject(new Error(`${describe}: response body exceeded 1 MB`));
        }
      });
      res.once("end", () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, headers: res.headers, body: text });
      });
      res.once("error", fail);
    });
    req.once("error", fail);
    req.end(body ?? undefined);
  });
}
