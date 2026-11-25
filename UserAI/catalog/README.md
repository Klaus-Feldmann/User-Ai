# User AI catalog v1

The catalog is an authenticated MediaWiki API contract. It requires an enrolled
assistant account, with UAI enabled and the MediaWiki read right. Action and
REST calls apply the same UAI gate. The REST write operations also require CSRF
and the native MediaWiki/SWS permissions. Existing SWS REST routes and their own
access policy remain outside this contract.

## Discovery

1. Authenticate to the target wiki under the enrolled assistant account.
2. Call its Action API with `action=userai&operation=context&format=json&formatversion=2`.
   Confirm the actor ID and `catalogVersion`.
3. Call `operation=catalog` via the same Action API. Decode the JSON string at
   `userai.data` exactly once. It contains `version: 1` and `tools`.
4. Publish one MCP tool per `name`, using its `description`, `inputSchema` and
   `annotations`. The inputs use JSON Schema 2020-12. The adapter binds tools to
   the authenticated wiki. A multi-wiki host can give that binding its own
   selector outside the catalog arguments.

Refuse an unknown catalog version. Refresh discovery after changing the wiki,
account or connection. The legacy `context.tools` and `context.operations`
are kept for the original adapter. The version of the catalog and of the Action
API envelope are independent.

## Invoking a tool

Validate arguments against `inputSchema`. Take the first call whose `when`
condition matches. A call without `when` always matches. `present` checks that
the argument was supplied; `equals` compares its JSON value. `require` is an
additional requirement for the chosen variant.

- `prepare` lists operations in order. `resolve-page-id` accepts a numeric ID
  or resolves a page title with `action=query`. `initialize-identity` fills
  omitted create identity from the wiki language and label. An update with
  `merge-current-identity` reads the latest accessible entity to complete
  omitted labels and descriptions. The update still replaces all statements
  and can be bound to the user's `baseRevisionId`.
- `transport: action` invokes the `userai` Action module with the given
  `operation`. Parameter maps have wire keys on the left and tool argument
  names on the right. Merge mapped values over `defaults`. If
  `jsonParameter` is present, encode the merged map as one JSON string in
  that parameter. Decode `userai.data` when `response` is `json-data`.
- `transport: rest` invokes `method` and `path` at the same wiki's REST root.
  Encode each path parameter separately. Apply `queryValues` and the mapped
  `query` values. Include only listed `body` arguments. When `csrf` is true,
  send the current account's CSRF token in `X-CSRF-TOKEN`.
- `transport: wiki-action` invokes the named MediaWiki action and extracts
  `responseKey`. In v1 it covers SWS processing status.
- Check Action API errors even on HTTP success. Preserve REST errors,
  particularly 403 and 409. Never repeat a failed or uncertain write through a
  different route. The reference returns decoded Wiki API payloads. An MCP host
  can preserve its own response formatting, error classification and size limits.

`backend` indicates which configuration entry applies. An adapter may omit a
graph tool when its backend is explicitly unconfigured. Configuration evidence
does not establish connectivity or graph freshness. For these Fuseki
projections, use named graphs, for example `ASK WHERE { GRAPH ?g { ?s ?p ?o } }`.

## Provisioning a profile

The context returns the stored profile or its availability status. When the
context reports a missing revision, the host may retrieve the authenticated
`profile-template` and create the active account's own `User:<name>/profil`
through MediaWiki with `createonly`, `assertuser` and CSRF. Reload the context
after creation or a concurrent create. The reference client performs this only
when called explicitly with writes enabled.

## Porting

`reference/client.mjs` exposes catalog loading, MCP tool definitions and
invocation without an MCP or OAuth dependency. `reference/mediawiki-transport.mjs`
provides HTTP translation. The host supplies the authenticated fetch, validates
tool arguments, enforces its write approval rules and handles its MCP
connection. Its credential provider and any generic tools for wiki pages,
categories, SMW or Wikibase can be implemented independently.

Tests use a controlled mock transport. For a live migration, use the same
source wiki and assistant account with a separate host, compare the catalog,
entity search, current revision reads and SPARQL responses, and then exercise
a temporary write and rollback on a test wiki or test page before switching.

Parts of the tool descriptions and input definitions were adapted from the
[MediaWiki MCP Server](https://github.com/ProfessionalWiki/mediawiki-mcp-server).
Its copyright and MIT license are reproduced in [help/LICENSE-MIT](../help/LICENSE-MIT).

## Supervisor approval in UAI Beta.4

With connection approval enabled, use OAuth 2.0 and first POST
`connection-request` on the User AI Action API. Open the returned
`approvalUrl` for the assigned supervisor and display its verification
code. Keep `connectionProof` private and in memory. Pass it as
`X-UAI-Connection` on a POST to `connection-claim`. An active claim
must precede protected operations. Send that header with the same OAuth
access token for each subsequent Action or REST request. The supervisor
can revoke the connection at the approval URL. A changed access token
requires another approval. The optional POST `connection-identity`
returns only the authenticated assistant ID for OAuth login setup.
