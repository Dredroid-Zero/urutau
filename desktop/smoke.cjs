'use strict';

// Test the exact bundled production API without requiring a GUI or internet.
const assert = require('node:assert/strict');
const path = require('node:path');
process.env.URUTAU_EMBEDDED = '1';
process.env.NODE_ENV = 'production';

async function main() {
  const { startServer } = require('../dist-server/server.cjs');
  const server = await startServer({
    production: true,
    host: '127.0.0.1',
    port: 0,
    staticDir: path.resolve(__dirname, '..', 'dist'),
    dataDir: path.resolve(__dirname, '..', '.desktop-smoke-data'),
  });
  try {
    assert.ok(server.url.startsWith('http://127.0.0.1:'));
    const health = await fetch(server.url + '/api/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, 'urutau-backend');
    const response = await fetch(server.url + '/');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /URUTAU/i);
    console.log('Portable server smoke test passed.');
  } finally {
    await server.close();
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
