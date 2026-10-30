// MCP server definition: the PACER tools, bound to one set of credentials.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { PacerClient, PacerError } from './pacer.js';

const PKG_VERSION = '1.0.0';

const BILLING_NOTE = 'PACER bills the connected account for every search ($0.10 per page of results, capped per search).';

// Words that mark a name as an organisation, which PCL matches as one lastName.
const ORG_WORDS = /\b(inc|llc|l\.l\.c|ltd|corp|corporation|co|company|lp|llp|plc|bank|trust|group|holdings|association|university|county|city|state|united|department|dept|of|the|and|&)\b\.?/i;

/**
 * Turn a free-form party name into PCL's lastName/firstName criteria.
 * "Henderson, Nicholas" and "Nicholas Henderson" both give last=Henderson, first=Nicholas;
 * organisations ("Lytx Inc") and single words go whole into lastName.
 */
export function splitPartyName(name) {
    const n = name.trim().replace(/\s+/g, ' ');
    if (n.includes(',') && !ORG_WORDS.test(n)) {
        const [last, ...rest] = n.split(',');
        const first = rest.join(' ').trim();
        return first ? { lastName: last.trim(), firstName: first } : { lastName: last.trim() };
    }
    const words = n.split(' ');
    if (words.length < 2 || words.length > 4 || ORG_WORDS.test(n)) return { lastName: n };
    return { lastName: words[words.length - 1], firstName: words.slice(0, -1).join(' ') };
}

const nameCriteria = ({ party_name, last_name, first_name }) => {
    if (last_name) return { lastName: last_name, ...(first_name ? { firstName: first_name } : {}) };
    return party_name ? splitPartyName(party_name) : null;
};

const courts = (court_id) => (court_id ? court_id.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean) : undefined);

function caseSummary(c = {}) {
    return {
        court_id: c.courtId,
        case_number: c.caseNumberFull,
        title: c.caseTitle,
        case_type: c.caseType,
        date_filed: c.dateFiled,
        date_terminated: c.dateTermed || null,
        nature_of_suit: c.natureOfSuit || null,
        jurisdiction: c.jurisdictionType || null,
        bankruptcy_chapter: c.bankruptcyChapter || null,
        case_link: c.caseLink || null,
    };
}

function partySummary(p = {}) {
    const name = [p.firstName, p.middleName, p.lastName, p.generation].filter(Boolean).join(' ');
    const c = p.courtCase || p;
    return {
        name,
        last_name: p.lastName,
        first_name: p.firstName || null,
        role: p.partyRole || null,
        party_type: p.partyType || null,
        case: caseSummary(c),
    };
}

function paging(res) {
    const pi = res.pageInfo || {};
    return {
        page: pi.number ?? 0,
        total_pages: pi.totalPages ?? null,
        total_results: pi.totalElements ?? null,
        last_page: pi.last ?? null,
    };
}

function receipt(res) {
    const r = res.receipt;
    if (!r) return null;
    return { billable_pages: r.billablePages ?? null, fee: r.searchFee ?? null, description: r.description || r.search || null };
}

function ok(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function fail(err) {
    const text = err instanceof PacerError ? err.message : `Unexpected error: ${err?.message || err}`;
    return { content: [{ type: 'text', text }], isError: true };
}

const page = z.number().int().min(0).optional().describe('0-based result page (PCL returns up to 54 results per page). Default 0.');
const courtId = z.string().optional()
    .describe('Court ID(s) to restrict the search, comma-separated, e.g. "ilndc" (N.D. Illinois district) or "ilnbk" (bankruptcy).');
const partyName = z.string().optional()
    .describe('Party name, e.g. "Nicholas Henderson", "Henderson, Nicholas" or "Lytx Inc". Split into last/first name automatically; use last_name/first_name to control it.');
const lastName = z.string().optional().describe('Party last name, or the full name of an organisation. Overrides party_name.');
const firstName = z.string().optional().describe('Party first name. Used with last_name.');

/**
 * Build an MCP server whose tools search PACER with the given credentials.
 * @param {() => PacerClient} getClient  called lazily so tools/list works without credentials
 */
export function createServer(getClient) {
    const server = new McpServer(
        { name: 'pacer-mcp', version: PKG_VERSION },
        { instructions: `Live search of the PACER Case Locator across all US federal courts. ${BILLING_NOTE} Prefer narrow searches (court_id, dates) to keep costs down.` },
    );

    server.registerTool('pacer_case_search', {
        title: 'Search federal court cases',
        description: 'Find US federal court cases by case title, case number, or party name: a live search of the PACER Case Locator across '
            + 'every federal district, bankruptcy, and appellate court. Returns case number, title, court, filing date, nature of suit, and case type. '
            + `A party name is searched through the PCL party index and the matching cases returned. ${BILLING_NOTE}`,
        inputSchema: {
            case_title: z.string().optional().describe('Case title / caption text, e.g. "Lytx, Inc. v. Sanderson" (not case-sensitive).'),
            case_number: z.string().optional().describe('Full case number, e.g. "1:2015cv01445".'),
            party_name: partyName,
            last_name: lastName,
            first_name: firstName,
            court_id: courtId,
            date_filed_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Filing-date lower bound, yyyy-MM-dd.'),
            date_filed_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Filing-date upper bound, yyyy-MM-dd.'),
            case_type: z.string().optional().describe('Case type code(s), comma-separated, e.g. "cv" (civil), "cr" (criminal), "bk" (bankruptcy).'),
            nature_of_suit: z.string().optional().describe('Nature-of-suit code(s), comma-separated, e.g. "830" (patent).'),
            page,
        },
    }, async (args) => {
        try {
            const party = nameCriteria(args);
            if (!party && !args.case_title && !args.case_number) {
                return fail(new PacerError('Provide at least one of case_title, case_number, party_name or last_name.'));
            }
            if (party && (args.case_title || args.case_number)) {
                return fail(new PacerError('Search by party name or by case title/number, not both: PCL indexes them separately.'));
            }
            const client = getClient();
            const list = (s) => (s ? s.split(',').map((v) => v.trim()).filter(Boolean) : undefined);

            if (party) {
                const criteria = { ...party, courtId: courts(args.court_id) };
                const res = await client.findParties(criteria, args.page ?? 0);
                const seen = new Map();
                for (const p of res.content || []) {
                    const c = caseSummary(p.courtCase || p);
                    const key = `${c.court_id}|${c.case_number}`;
                    if (!seen.has(key)) seen.set(key, { ...c, matched_parties: [] });
                    seen.get(key).matched_parties.push(partySummary(p).name);
                }
                let cases = [...seen.values()];
                if (args.date_filed_from) cases = cases.filter((c) => !c.date_filed || c.date_filed >= args.date_filed_from);
                if (args.date_filed_to) cases = cases.filter((c) => !c.date_filed || c.date_filed <= args.date_filed_to);
                return ok({ searched_by: 'party', criteria, ...paging(res), receipt: receipt(res), cases });
            }

            const criteria = {
                caseTitle: args.case_title,
                caseNumberFull: args.case_number,
                courtId: courts(args.court_id),
                dateFiledFrom: args.date_filed_from,
                dateFiledTo: args.date_filed_to,
                caseType: list(args.case_type),
                natureOfSuit: list(args.nature_of_suit),
            };
            const res = await client.findCases(criteria, args.page ?? 0);
            return ok({ searched_by: 'case', criteria, ...paging(res), receipt: receipt(res), cases: (res.content || []).map(caseSummary) });
        } catch (err) {
            return fail(err);
        }
    });

    server.registerTool('pacer_party_search', {
        title: 'Search federal court parties',
        description: 'Find parties across US federal court cases by name: a live PACER Case Locator party search across all federal courts. '
            + `Returns each matching party (name, role) with the associated case number, court, and case title. ${BILLING_NOTE}`,
        inputSchema: {
            party_name: partyName,
            last_name: lastName,
            first_name: firstName,
            court_id: courtId,
            role: z.string().optional().describe('Party role code(s), comma-separated, e.g. "dft" (defendant) or "pla" (plaintiff).'),
            exact_match: z.boolean().optional().describe('Match the name exactly instead of as a prefix. Default false.'),
            page,
        },
    }, async (args) => {
        try {
            const party = nameCriteria(args);
            if (!party) return fail(new PacerError('Provide party_name or last_name.'));
            const criteria = {
                ...party,
                courtId: courts(args.court_id),
                role: args.role ? args.role.split(',').map((r) => r.trim().toLowerCase()).filter(Boolean) : undefined,
                exactNameMatch: args.exact_match || undefined,
            };
            const res = await getClient().findParties(criteria, args.page ?? 0);
            return ok({ criteria, ...paging(res), receipt: receipt(res), parties: (res.content || []).map(partySummary) });
        } catch (err) {
            return fail(err);
        }
    });

    return server;
}
