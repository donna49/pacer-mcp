import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { ENVIRONMENTS, PacerClient, totp } from '../src/pacer.js';
import { createServer, splitPartyName } from '../src/server.js';

test('splitPartyName', () => {
    assert.deepEqual(splitPartyName('Nicholas Henderson'), { lastName: 'Henderson', firstName: 'Nicholas' });
    assert.deepEqual(splitPartyName('Henderson, Nicholas J'), { lastName: 'Henderson', firstName: 'Nicholas J' });
    assert.deepEqual(splitPartyName('Smith'), { lastName: 'Smith' });
    assert.deepEqual(splitPartyName('Lytx, Inc.'), { lastName: 'Lytx, Inc.' });
    assert.deepEqual(splitPartyName('Bank of America'), { lastName: 'Bank of America' });
});

test('totp matches the RFC 6238 SHA-1 vectors', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32("12345678901234567890")
    assert.equal(totp(secret, 59_000), '287082');
    assert.equal(totp(secret, 1_111_111_109_000), '081804');
});

// ── A stub PACER: auth service + PCL ────────────────────────────────

let stub;
const calls = [];
let logins = 0;
let expireNext = false;

before(async () => {
    stub = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const json = body ? JSON.parse(body) : {};
            calls.push({ url: req.url, headers: req.headers, json });
            const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/auth') {
                if (json.password !== 'secret') return send(200, { loginResult: '13', errorDescription: 'Invalid username or password' });
                logins += 1;
                return send(200, { loginResult: '0', nextGenCSO: `tok${logins}` });
            }
            if (expireNext) { expireNext = false; return send(401, { message: 'expired' }); }
            const receipt = { billablePages: 1, searchFee: '0.10' };
            const pageInfo = { number: 0, totalPages: 1, totalElements: 2, last: true };
            if (req.url.startsWith('/pcl/cases/find')) {
                return send(200, { receipt, pageInfo, content: [{ courtId: 'ilndc', caseNumberFull: '1:2015cv01445', caseTitle: 'Lytx, Inc. v. Sanderson', caseType: 'cv', dateFiled: '2015-02-17', natureOfSuit: '830' }] });
            }
            if (req.url.startsWith('/pcl/parties/find')) {
                const courtCase = { courtId: 'ilndc', caseNumberFull: '1:2020cv00001', caseTitle: 'Doe v. Henderson', dateFiled: '2020-01-02' };
                return send(200, { receipt, pageInfo, content: [
                    { lastName: 'Henderson', firstName: 'Nicholas', partyRole: 'dft', courtCase },
                    { lastName: 'Henderson', firstName: 'Nick', partyRole: 'dft', courtCase },
                ] });
            }
            send(404, {});
        });
    });
    await new Promise((r) => stub.listen(0, r));
    const base = `http://127.0.0.1:${stub.address().port}`;
    ENVIRONMENTS.stub = { authUrl: `${base}/auth`, logoutUrl: `${base}/logout`, pclUrl: `${base}/pcl` };
});

after(() => stub.close());

async function connect(creds) {
    const server = createServer(() => new PacerClient(creds, 'stub'));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
}

test('lists both tools without credentials', async () => {
    const client = await connect({});
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['pacer_case_search', 'pacer_party_search']);
});

test('missing credentials is a tool error, not a crash', async () => {
    const client = await connect({});
    const r = await client.callTool({ name: 'pacer_case_search', arguments: { case_title: 'x' } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /credentials are missing/);
});

test('case search by title sends PCL criteria with the token', async () => {
    const client = await connect({ username: 'u1', password: 'secret' });
    const r = await client.callTool({ name: 'pacer_case_search', arguments: { case_title: 'Lytx v. Sanderson', court_id: 'ILNDC' } });
    assert.ok(!r.isError, r.content[0].text);
    const last = calls.at(-1);
    assert.match(last.url, /^\/pcl\/cases\/find\?page=0$/);
    assert.match(last.headers['x-next-gen-cso'], /^tok\d+$/);
    assert.deepEqual(last.json, { caseTitle: 'Lytx v. Sanderson', courtId: ['ilndc'] });
    assert.equal(r.structuredContent.cases[0].case_number, '1:2015cv01445');
    assert.equal(r.structuredContent.receipt.fee, '0.10');
});

test('case search by party dedupes cases', async () => {
    const client = await connect({ username: 'u1', password: 'secret' });
    const r = await client.callTool({ name: 'pacer_case_search', arguments: { party_name: 'Nicholas Henderson' } });
    assert.deepEqual(calls.at(-1).json, { lastName: 'Henderson', firstName: 'Nicholas' });
    assert.equal(r.structuredContent.cases.length, 1);
    assert.deepEqual(r.structuredContent.cases[0].matched_parties, ['Nicholas Henderson', 'Nick Henderson']);
});

test('party search reuses the cached token and re-logs in once on 401', async () => {
    const client = await connect({ username: 'u2', password: 'secret' });
    await client.callTool({ name: 'pacer_party_search', arguments: { last_name: 'Henderson', role: 'DFT' } });
    const before = logins;
    await client.callTool({ name: 'pacer_party_search', arguments: { last_name: 'Henderson' } });
    assert.equal(logins, before, 'second call reuses the token');
    expireNext = true;
    const r = await client.callTool({ name: 'pacer_party_search', arguments: { last_name: 'Henderson' } });
    assert.ok(!r.isError);
    assert.equal(logins, before + 1, 'one re-login after 401');
    assert.equal(r.structuredContent.parties[0].role, 'dft');
});

test('bad password reports the PACER login error', async () => {
    const client = await connect({ username: 'u3', password: 'wrong' });
    const r = await client.callTool({ name: 'pacer_party_search', arguments: { party_name: 'Smith' } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /PACER login failed: Invalid username or password/);
});
