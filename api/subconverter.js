const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');

const SUBCONVERTER_PORT = Number(process.env.SUBCONVERTER_PORT || 25500);
const BINARY_RELATIVE_PATH = path.join('subconverter', 'subconverter.exe');
const BINARY_PATH = path.join(__dirname, '..', BINARY_RELATIVE_PATH);
const BINARY_CWD = path.dirname(BINARY_PATH);
const PORT_WAIT_TIMEOUT = Number(process.env.SUBCONVERTER_PORT_TIMEOUT || 10000);
const PORT_POLL_INTERVAL = 200;

let runningProcess;
let startingPromise;

function isProcessActive(child) {
  return !!child && child.exitCode === null && !child.killed;
}

function waitForServerReady(child, port, { host = '127.0.0.1', timeout = PORT_WAIT_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let retryTimer;
    let finished = false;

    const cleanup = () => {
      finished = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      child.removeListener('exit', handleExit);
      child.removeListener('error', handleError);
    };

    const handleError = (error) => {
      if (finished) {
        return;
      }
      cleanup();
      reject(error);
    };

    const handleExit = (code, signal) => {
      if (finished) {
        return;
      }
      cleanup();
      reject(new Error(`subconverter exited before becoming ready (code: ${code}, signal: ${signal})`));
    };

    const attemptConnection = () => {
      if (finished) {
        return;
      }
      const socket = net.createConnection({ host, port }, () => {
        socket.end();
        cleanup();
        resolve();
      });

      socket.once('error', (error) => {
        socket.destroy();
        if (Date.now() - startTime >= timeout) {
          cleanup();
          reject(new Error(`Timed out waiting for subconverter to listen on port ${port}`));
          return;
        }
        retryTimer = setTimeout(attemptConnection, PORT_POLL_INTERVAL);
      });
    };

    child.once('exit', handleExit);
    child.once('error', handleError);
    attemptConnection();
  });
}

async function ensureProcessStarted() {
  if (isProcessActive(runningProcess)) {
    return runningProcess;
  }

  if (!startingPromise) {
    startingPromise = (async () => {
      const child = spawn(BINARY_PATH, [], {
        cwd: BINARY_CWD,
        stdio: ['ignore', 'inherit', 'inherit']
      });

      runningProcess = child;

      try {
        await waitForServerReady(child, SUBCONVERTER_PORT);
        return child;
      } catch (error) {
        if (isProcessActive(child)) {
          child.kill();
        }
        runningProcess = undefined;
        throw error;
      } finally {
        startingPromise = undefined;
      }
    })();
  }

  return startingPromise;
}

function proxyHttpRequest(req, res) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      req.removeListener('error', onReqError);
      res.removeListener('close', onResClose);
      if (proxyReq) {
        proxyReq.removeListener('error', onProxyError);
      }
      if (proxyRes) {
        proxyRes.removeListener('error', onProxyResponseError);
        proxyRes.removeListener('end', onProxyResponseEnd);
      }
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const onReqError = (error) => finish(error);
    const onResClose = () => finish();
    const onProxyError = (error) => finish(error);

    let proxyReq;
    let proxyRes;
    const onProxyResponseError = (error) => finish(error);
    const onProxyResponseEnd = () => finish();

    const headers = { ...req.headers };
    headers.host = `127.0.0.1:${SUBCONVERTER_PORT}`;
    delete headers.connection;

    const options = {
      hostname: '127.0.0.1',
      port: SUBCONVERTER_PORT,
      method: req.method,
      path: req.url,
      headers
    };

    proxyReq = http.request(options, (incoming) => {
      proxyRes = incoming;
      proxyRes.once('error', onProxyResponseError);
      proxyRes.once('end', onProxyResponseEnd);

      if (!res.headersSent) {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      }
      proxyRes.pipe(res);
    });

    proxyReq.once('error', onProxyError);
    req.once('error', onReqError);
    res.once('close', onResClose);

    req.pipe(proxyReq);
  });
}

module.exports = async (req, res) => {
  try {
    await ensureProcessStarted();
    await proxyHttpRequest(req, res);
  } catch (error) {
    console.error('Failed to proxy request to subconverter:', error);
    if (isProcessActive(runningProcess)) {
      runningProcess.kill();
      runningProcess = undefined;
    }
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    }
    res.end('subconverter service unavailable');
  }
};
