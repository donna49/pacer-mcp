# PACER MCP Server

An [MCP](https://modelcontextprotocol.io) server for the **PACER Case Locator (PCL)**: live search of US federal court cases and parties across every district, bankruptcy, and appellate court, using **your own PACER account**. It runs on [Apify](https://apify.com) as a Standby Actor, so there's nothing to install: point your MCP client at the Actor's URL.

> PACER bills your account for every search ($0.10 per page of results, capped per search). This is an independent, unofficial integration, not affiliated with the Administrative Office of the US Courts.

## Tools

| Tool | What it does |
|------|--------------|
| `pacer_case_search` | Find cases by case title, case number, or party name. Filters: court, filing dates, case type, nature of suit. A party name is searched through the PCL party index and the matching cases are returned (de-duplicated). |
| `pacer_party_search` | Find parties by name, with their role and the associated case (number, court, title). Filters: court, role (`dft`, `pla`, ...), exact match. |

Every result includes PCL's paging info (`page`, `total_pages`, `total_results`) and the PACER billing `receipt` for that search.

Party names can be given as `party_name` ("Nicholas Henderson", "Henderson, Nicholas", "Lytx Inc"), which is split into last/first name automatically (organisations stay whole), or as explicit `last_name` / `first_name`.

## Connect

The MCP endpoint is the Actor's Standby URL plus `/mcp` (shown in the Actor's **Server** tab in Apify Console), using the Streamable HTTP transport. Authenticate with your Apify API token:

```json
{
  "mcpServers": {
    "pacer": {
      "url": "https://<username>--pacer-mcp.apify.actor/mcp",
      "headers": {
        "Authorization": "Bearer <APIFY_TOKEN>"
      }
    }
  }
}
```

### PACER credentials

Give the server your PACER login in **one** of two ways. Credentials are never tool arguments, so they never pass through the model.

1. **Headers on the MCP connection** (best for a shared deployment, since every client brings its own account):

   ```json
   "headers": {
     "Authorization": "Bearer <APIFY_TOKEN>",
     "X-Pacer-Username": "<pacer login>",
     "X-Pacer-Password": "<pacer password>"
   }
   ```

   Optional: `X-Pacer-Client-Code`, `X-Pacer-Totp-Secret` (accounts with MFA), `X-Pacer-Redact-Flag: 1` (filer accounts).

2. **Actor input**, stored encrypted as secret fields: `pacerUsername`, `pacerPassword`, and optionally `pacerClientCode`, `pacerTotpSecret`, `redactFlag`, `environment`. Save the Actor as a **task** with this input, turn on **Validate and pass Actor input** in the task's Standby settings, and connect to the task's URL instead of the Actor's.

Headers win over the Actor input when both are present.

**MFA:** if your PACER account has multi-factor authentication, provide the base32 secret from your authenticator enrollment as `pacerTotpSecret`. The server generates the one-time code at each login.

**Testing:** set `environment` to `qa` to use PACER's QA environment (separate QA account, no charges).

## How it works

- Logs in to the PACER authentication service (`pacer.login.uscourts.gov/services/cso-auth`) to get a NextGen token, caches it per account for the life of the Standby run, and logs in again once if PCL answers 401.
- Calls the PCL API (`pcl.uscourts.gov/pcl-public-api/rest/cases/find` and `/parties/find`).
- Ends every PACER session when the run shuts down.
- The MCP server is stateless (no MCP sessions), so Apify can scale Standby runs freely.

## Development

```bash
npm install
npm test
```

Run the server locally in Standby mode, on `http://localhost:4321/mcp`:

```bash
APIFY_META_ORIGIN=STANDBY ACTOR_WEB_SERVER_PORT=4321 npm start
```

Deploy with the [Apify CLI](https://docs.apify.com/cli/):

```bash
apify login
apify push
```

Standby mode and the `/mcp` path are set in `.actor/actor.json`.

## License

MIT
