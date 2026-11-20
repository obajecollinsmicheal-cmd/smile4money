
### Provider evidence and operator review

Chess.com monthly archive traversal uses UTC and is bounded by
`CHESSDOTCOM_ARCHIVE_MONTHS` (default 120 months, allowed range 1–600). A not-found
response means the game was absent from that configured range; increase the limit
for older wagers. Requests remain subject to the shared provider rate limiter.
Lichess uses its [single game JSON export](https://lichess.org/api#tag/Games/operation/gameExport).
Both fetchers return `finished` or `in_progress`, explicit `Player1Wins`,
`Player2Wins`, `Draw`, or null, and an ISO 8601 UTC `endedAt` (null for active
games). At the provider boundary Player1 is white and Player2 is black.
Unknown, contradictory or incomplete terminal evidence is never inferred as a draw.

Oracle verification writes an append-only evidence ledger before returning a
verified result. Configure `ORACLE_EVIDENCE_DB` to an absolute path on persistent
storage (default `apps/backend/data/oracle-evidence.db` when running source).
Back up this database alongside the match database. Records retain provider,
fetch time, parser version, response SHA-256, source reference, normalized outcome
and timestamp; raw responses, profiles and PGNs are not retained. The hash allows
correlation with separately obtained evidence, not reconstruction of a response.
The returned `decisionId` identifies that record; retain it in `OracleSubmission`
through retries and DLQ processing. Poll completion callbacks receive it as their
third argument. The existing contract submission handler remains unimplemented.

Ambiguous evidence, mismatched player identities, or a changed verified outcome
persist `review_required`. Subsequent verification stops before fetching again,
and polling removes the held job without invoking submission or DLQ callbacks.
Set `ORACLE_ADMIN_ADDRESSES` to a comma-separated allowlist of Stellar addresses.
Administrators authenticate with the existing JWT flow and can:

- `GET /api/oracle/reviews/:gameId` to inspect the decision and evidence history.
- `POST /api/oracle/reviews/:gameId/retry` with only `{ "reason": "Provider corrected evidence" }`
  to append an audited retry request. Then call the regular submit-result endpoint
  to fetch and verify again (or explicitly recreate a removed polling job).

The allowlist defaults to empty. Regular authenticated users cannot review or
release holds. Retry requests cannot specify a winner, sign a transaction, or
change on-chain authorization. Evidence still conflicting with an earlier verified
outcome returns to review. The service serializes review and verification per game
within one backend process; run one process per evidence database. Keep operator
reasons free of personal data. Actual on-chain settlement continues to require the
contract's privileged oracle authorization.

### Error classification

Every logged error carries a severity so operators can filter and alert on it.
The four levels, from most to least urgent, are `critical`, `error`, `warning`,
and `info`. Severity is assigned per entry when it is logged; entries without an
explicit level default to `error`.

Filtering: pass a `severity` (or minimum severity) to the logger/queue query to
narrow results to a single level or to everything at or above a threshold.

Alerting: `critical` and `error` entries raise alerts; `warning` and `info` are
recorded for filtering only. Route alerts through the existing logger/queue
alerting hooks so severity drives whether an operator is paged.
