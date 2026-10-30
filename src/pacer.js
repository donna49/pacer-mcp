// PACER Case Locator (PCL) API client.
//
// Two hosts are involved:
//   - the PACER authentication service, which trades a NextGen login for a
//     `nextGenCSO` token, and
//   - the PCL public API, which takes that token in the X-NEXT-GEN-CSO header.
// Tokens are cached per account for the life of the process and refreshed once
// when PCL answers 401. Every PCL search is billed to the account by PACER.

import { createHash, createHmac } from 'node:crypto';

export const ENVIRONMENTS = {
    production: {
        authUrl: 'https://pacer.login.uscourts.gov/services/cso-auth',
        logoutUrl: 'https://pacer.login.uscourts.gov/services/cso-logout',
        pclUrl: 'https://pcl.uscourts.gov/pcl-public-api/rest',
    },
    qa: {
        authUrl: 'https://qa-login.uscourts.gov/services/cso-auth',
        logoutUrl: 'https://qa-login.uscourts.gov/services/cso-logout',
        pclUrl: 'https://qa-pcl.uscourts.gov/pcl-public-api/rest',
    },
};

const TIMEOUT_MS = 60_000;

export class PacerError extends Error {
    constructor(message, { status, details } = {}) {
        super(message);
        this.name = 'PacerError';
        this.status = status;
        this.details = details;
    }
}

// ── TOTP (RFC 6238) for accounts with multi-factor authentication ────

function base32Decode(input) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const clean = input.toUpperCase().replace(/[\s=-]/g, '');
    let bits = 0;
    let value = 0;
    const out = [];
    for (const ch of clean) {
        const idx = alphabet.indexOf(ch);
        if (idx === -1) throw new PacerError('The PACER TOTP secret is not valid base32.');
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

export function totp(secret, now = Date.now()) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
    const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
    return String(code).padStart(6, '0');
}

// ── HTTP ─────────────────────────────────────────────────────────────

async function postJson(url, body, headers = {}) {
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (err) {
        const reason = err?.name === 'TimeoutError' ? `no answer within ${TIMEOUT_MS / 1000}s` : (err?.cause?.code || err?.message);
        throw new PacerError(`Could not reach ${new URL(url).host}: ${reason}`);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, ok: res.ok, json, text };
}

function errorMessage(out) {
    const j = out.json;
    if (j) {
        if (Array.isArray(j.errors) && j.errors.length) {
            return j.errors.map((e) => (typeof e === 'string' ? e : e.message || e.description || JSON.stringify(e))).join('; ');
        }
        if (j.message) return j.message;
        if (j.errorDescription) return j.errorDescription;
    }
    const line = (out.text || '').trim().split(/\r?\n/)[0] || '(empty body)';
    return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

// ── Client ───────────────────────────────────────────────────────────

const tokenCache = new Map(); // account key -> { token: Promise<string>, logoutUrl }

export class PacerClient {
    /**
     * @param {object} creds
     * @param {string} creds.username      PACER login ID
     * @param {string} creds.password
     * @param {string} [creds.clientCode] PACER client code, if the account requires one
     * @param {string} [creds.totpSecret] base32 MFA secret, if the account has MFA enabled
     * @param {boolean} [creds.redactFlag] the filer's attestation of redaction-rule compliance
     * @param {'production'|'qa'} [environment]
     */
    constructor(creds, environment = 'production') {
        if (!creds?.username || !creds?.password) {
            throw new PacerError('PACER credentials are missing. Set pacerUsername and pacerPassword in the Actor input, '
                + 'or send the X-Pacer-Username and X-Pacer-Password headers with the MCP connection.');
        }
        this.creds = creds;
        this.env = ENVIRONMENTS[environment];
        if (!this.env) throw new PacerError(`Unknown PACER environment "${environment}".`);
        this.key = createHash('sha256')
            .update([environment, creds.username, creds.password, creds.clientCode || ''].join('\0'))
            .digest('hex');
    }

    async login() {
        const body = { loginId: this.creds.username, password: this.creds.password };
        if (this.creds.clientCode) body.clientCode = this.creds.clientCode;
        if (this.creds.totpSecret) body.otpCode = totp(this.creds.totpSecret);
        if (this.creds.redactFlag) body.redactFlag = '1';
        const out = await postJson(this.env.authUrl, body);
        const j = out.json || {};
        if (!out.ok || String(j.loginResult) !== '0' || !j.nextGenCSO) {
            throw new PacerError(`PACER login failed: ${errorMessage(out)}`, { status: out.status, details: { loginResult: j.loginResult } });
        }
        return j.nextGenCSO;
    }

    token(refresh = false) {
        if (refresh) tokenCache.delete(this.key);
        if (!tokenCache.has(this.key)) {
            const token = this.login();
            tokenCache.set(this.key, { token, logoutUrl: this.env.logoutUrl });
            token.catch(() => tokenCache.delete(this.key));
        }
        return tokenCache.get(this.key).token;
    }

    async pcl(path, body, page = 0) {
        const url = `${this.env.pclUrl}${path}?page=${encodeURIComponent(page)}`;
        let out = await postJson(url, body, { 'X-NEXT-GEN-CSO': await this.token() });
        if (out.status === 401) out = await postJson(url, body, { 'X-NEXT-GEN-CSO': await this.token(true) });
        if (!out.ok) {
            throw new PacerError(`PACER Case Locator returned HTTP ${out.status}: ${errorMessage(out)}`, { status: out.status });
        }
        return out.json || {};
    }

    /** POST /cases/find. `criteria` uses PCL field names. */
    findCases(criteria, page = 0) {
        return this.pcl('/cases/find', criteria, page);
    }

    /** POST /parties/find. `criteria` uses PCL field names. */
    findParties(criteria, page = 0) {
        return this.pcl('/parties/find', criteria, page);
    }
}

/** End every cached PACER session. Called when the Actor shuts down. */
export async function logoutAll() {
    const sessions = [...tokenCache.values()];
    tokenCache.clear();
    await Promise.allSettled(sessions.map(async ({ token, logoutUrl }) => {
        await postJson(logoutUrl, { nextGenCSO: await token });
    }));
}
