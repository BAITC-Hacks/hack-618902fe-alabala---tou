const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');

function startServer() {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    function attempt() {
      attempts++;
      const port = 49152 + Math.floor(Math.random() * 16384);
      const child = spawn(process.execPath, ['serve-frontend.mjs'], {
        cwd: repo, env: {...process.env, FRONTEND_HOST: '127.0.0.1', FRONTEND_PORT: String(port)},
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let settled = false, output = '', errors = '';
      const timeout = setTimeout(() => {
        settled = true;
        child.kill();
        reject(new Error('Static frontend test server did not start within 5 seconds.'));
      }, 5000);
      child.stdout.on('data', chunk => {
        output += String(chunk);
        if (!settled && output.includes(`QORIT frontend: http://127.0.0.1:${port}`)) {
          settled = true;
          clearTimeout(timeout);
          resolve({child, port});
        }
      });
      child.stderr.on('data', chunk => { errors += String(chunk); });
      child.once('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error('Could not launch Node for static frontend tests.'));
      });
      child.once('exit', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if ((errors.includes('занят') || errors.includes('EADDRINUSE')) && attempts < 5) attempt();
        else if (/EPERM|EACCES|operation not permitted/i.test(errors)) {
          reject(new Error('Local socket binding is not permitted. Run this test with permission to listen on localhost.'));
        } else reject(new Error('Static frontend test server exited before startup.'));
      });
    }
    attempt();
  });
}

function request(port, requestPath, method = 'GET', readBody = true) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({hostname: '127.0.0.1', port, path: requestPath, method}, response => {
      // Do not collect blocked-file contents even if an allowlist regression exposes one.
      const chunks = [];
      response.on('data', chunk => { if (readBody) chunks.push(chunk); });
      response.on('end', () => resolve({status: response.statusCode, headers: response.headers,
        body: readBody ? Buffer.concat(chunks).toString('utf8') : ''}));
      response.on('error', reject);
    });
    outgoing.setTimeout(3000, () => outgoing.destroy(new Error('Static frontend request timed out.')));
    outgoing.on('error', reject);
    outgoing.end();
  });
}

test('frontend server serves only frontend assets and survives untrusted request targets', {timeout: 20000}, async t => {
  const {child, port} = await startServer();
  t.after(() => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once('exit', resolve);
    child.kill();
  }));

  await t.test('index and all browser modules are available without cache or MIME sniffing', async () => {
    const routes = ['/', '/index.html', '/app.js', '/transcript-analyzer.js', '/meeting-utils.js',
      '/protocol-export.js', '/protocol-storage.js', '/styles.css'];
    for (const route of routes) {
      const response = await request(port, route);
      assert.equal(response.status, 200, route);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['referrer-policy'], 'no-referrer');
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.ok(response.body.length > 0, route);
      assert.ok(response.headers['content-type'].includes(route.endsWith('.js') ? 'text/javascript' :
        route.endsWith('.css') ? 'text/css' : 'text/html'), route);
    }
    assert.equal((await request(port, '/app.js?v=example')).status, 200);
    const head = await request(port, '/');
    const headOnly = await request(port, '/', 'HEAD');
    assert.equal(headOnly.status, head.status);
    assert.equal(headOnly.body, '');
  });

  await t.test('secrets, backend, media, source repository and traversal are not public', async () => {
    const denied = ['/.env', '/.env.example', '/server.py', '/media/test.mp3', '/.git/config', '/README.md',
      '/package.json', '/serve-frontend.mjs', '/tests/test-frontend-server.cjs',
      '/%2e%2e/.env', '/../.env', '/%2e%2e%2f.env', '/..%5c.env', '/%2Eenv',
      '/app.js/../.env', '/app.js%00/.env', '/%2f.env', '//127.0.0.1/.env'];
    for (const route of denied) {
      const response = await request(port, route, 'GET', false);
      assert.equal(response.status, 404, `Denied route: ${route}`);
    }
  });

  await t.test('the frontend server cannot impersonate an audio API', async () => {
    for (const route of ['/process-audio', '/api/transcribe', '/', '/app.js']) {
      assert.equal((await request(port, route, 'POST', false)).status, 404, route);
    }
    assert.equal((await request(port, '/process-audio', 'OPTIONS', false)).status, 404);
  });

  await t.test('invalid absolute request targets fail safely instead of killing the server', async () => {
    const response = await request(port, 'http://[', 'GET', false);
    assert.ok(response.status === 400 || response.status === 404, 'Malformed target should receive a client error.');
    assert.equal((await request(port, '/')).status, 200, 'Server remains available after malformed target.');
    assert.equal(child.exitCode, null);
  });
});
