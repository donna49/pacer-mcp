// Apify Actor entry point: serves the PACER MCP server over Streamable HTTP in Standby mode.
//
// PACER credentials come from, in order:
//   1. request headers X-Pacer-Username / X-Pacer-Password (+ optional X-Pacer-Client-Code,
//      X-Pacer-Totp-Secret), so one deployment can serve many PACER accounts;
//   2. the Actor input (pacerUsername / pacerPassword / ...), e.g. a saved task with
//      "Validate and pass Actor input" enabled in its Standby settings.
// The Apify token never reaches this code: the platform strips it before forwarding.

import http from 'node:http';

import { Actor, log } from 'apify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { PacerClient, logoutAll } from './pacer.js';
import { createServer } from './server.js';

await Actor.init();

const input = (await Actor.getInput()) || {};
const MCP_PATH = '/mcp';
const MAX_BODY = 1024 * 1024;

if (Actor.config.get('metaOrigin') !== 'STANDBY') {
    log.info(`This Actor is an MCP server and runs in Standby mode. Connect an MCP client to ${Actor.config.get('standbyUrl') || '<standby URL>'}${MCP_PATH}.`);
    await Actor.exit();
}

const header = (req, name) => {
    const v = req.headers[name];
    return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
};

function credentialsFor(req) {
    const username = header(req, 'x-pacer-username');
    if (username) {
        return {
            username,
            password: header(req, 'x-pacer-password'),
            clientCode: header(req, 'x-pacer-client-code'),
            totpSecret: header(req, 'x-pacer-totp-secret'),
            redactFlag: header(req, 'x-pacer-redact-flag') === '1',
        };
    }
    return {
        username: input.pacerUsername,
        password: input.pacerPassword,
        clientCode: input.pacerClientCode,
        totpSecret: input.pacerTotpSecret,
        redactFlag: !!input.redactFlag,
    };
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY) {
                reject(Object.assign(new Error('Request body too large'), { status: 413 }));
                req.destroy();
            } else {
                chunks.push(c);
            }
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

const rpcError = (code, message) => ({ jsonrpc: '2.0', id: null, error: { code, message } });

async function handleMcp(req, res) {
    // Stateless server: no sessions, so there is no SSE stream to GET and nothing to DELETE.
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return sendJson(res, 405, rpcError(-32000, 'Method not allowed: this server is stateless, use POST.'));
    }
    let body;
    try {
        body = JSON.parse(await readBody(req));
    } catch (err) {
        return sendJson(res, err.status || 400, rpcError(-32700, err.status ? err.message : 'Parse error'));
    }

    const creds = credentialsFor(req);
    let client;
    const server = createServer(() => {
        client ??= new PacerClient(creds, input.environment || 'production');
        return client;
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
        transport.close();
        server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
}

const httpServer = http.createServer(async (req, res) => {
    try {
        const { pathname } = new URL(req.url, 'http://localhost');
        if (req.headers['x-apify-container-server-readiness-probe']) {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            return res.end('ok\n');
        }
        if (pathname === MCP_PATH) return await handleMcp(req, res);
        if (pathname === '/' && req.method === 'GET') {
            return sendJson(res, 200, { name: 'pacer-mcp', mcp_endpoint: MCP_PATH, transport: 'streamable-http' });
        }
        return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
        log.exception(err, 'Request failed');
        if (!res.headersSent) sendJson(res, 500, rpcError(-32603, 'Internal server error'));
        else res.end();
    }
});

const port = Actor.config.get('containerPort');
httpServer.listen(port, () => log.info(`PACER MCP server listening on port ${port}, endpoint ${MCP_PATH}`));

let shuttingDown = false;
async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    httpServer.close();
    await logoutAll();
    await Actor.exit();
}
Actor.on('aborting', shutdown);
Actor.on('migrating', shutdown);
process.on('SIGTERM', shutdown);
