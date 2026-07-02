# DVB-I / TV-Anytime Compliance Status

Last verified: 2026-07-01.

## What is validated, and how

**This project does not bundle or redistribute the ETSI/DVB XSD schema files.** XSD validation
(`test/xsd-validate.js`, `npm run test:xsd`) is opt-in and bring-your-own-schema: it looks for
`test/schemas/` locally (gitignored, never committed) and skips cleanly (exit 0) if that directory
isn't present, so `npm test` stays green with or without it. See the header comment in
`test/xsd-validate.js` for exactly which files to place there if you want to run it.

| Output | Namespace | Schema (if you supply it locally) |
|---|---|---|
| Service list | `urn:dvb:metadata:servicediscovery:2024` | `dvbi_v6.0-with-hls-hbbtv.xsd` (+ import closure) |
| EPG (schedule / now-next) | `urn:tva:metadata:2024` | `tva_metadata_3-1_2024.xsd` (+ `tva_mpeg7.xsd`) |

**Historical note (2026-07-01):** during development, this generator's output WAS machine-validated
against the real schemas (sourced temporarily from the `paulhiggs/dvb-i-tools` GitHub repo, BSD
2-Clause) and confirmed fully valid (structure, sequence order, cardinality, datatypes, namespaces).
That one-time validation run caught one violation a manual audit against the schema text had missed —
`AccessibilityAttributes` must be an unprefixed DVB-I element (its content TYPE is
`tva:AccessibilityAttributesType`, but the element itself is declared in the DVB-I namespace, not
TVA). That fix is in `server.js` and the receiver/importer parsers and does not depend on the schema
files being present. The schema files themselves were removed from this repository and are not
redistributed here — see CHANGELOG.md for context.

## Classification-scheme terms

CS `@href` values are typed `anyURI` by the schema, so XSD validation does not check CS membership.
The emitted terms were separately verified against the DVB/TVA CS registries and corrected where wrong:

- `ServiceTypeCS:2019` — `linear`, `linear-radio`, `ondemand` (was the non-existent `nonlinear`).
- `ContentCS:2011` — hierarchical termIDs, e.g. `3.1.1` News, `3.2` Sports, `3.4` Fiction/Drama,
  `3.5` Entertainment, `3.6` Music (was `ContentCS:2019` with non-existent `X.0.0` terms).
- `SubtitlePurposeCS:2023:2` = Hard of hearing (was the non-existent `:2009:HardOfHearing`).
- `SubtitleCarriageCS:2023`, `SubtitleCodingFormatCS:2023:2.1.3`, `LinkedApplicationCS:2019:1.1`,
  `HowRelatedCS:2021:1001.2` (service logo), `HowRelatedCS:2012:19` (promo image) — all verified.

## Known limitations / not done

- **XSD validation is not part of CI** (as of 2026-07-01) — the schema files are not bundled (see
  above), so CI only runs the unit tests. `npm run test:xsd` remains available for local use if you
  supply your own copy of the schemas.
- **Automated CS-membership checking is not in CI** either — only XSD validation (when schemas are
  supplied) covers that. CS terms were verified once, by hand, against the registry.
- **FairPlay DRM** is signalled but cannot fully work under this schema version: the license/certificate
  attributes (`DRMSystemId/@LAURL`, `@certificateURL`) exist only from DVB-I **v8.0**; the generator
  targets v6.0 (`servicediscovery:2024`). The receiver surfaces a clear error instead of failing
  opaquely. Full FairPlay would require migrating to the v8.0 schema.
- **Strict CSP** — the receiver CSP still allows `'unsafe-inline'` for scripts because the UI uses
  inline event handlers. Dropping it requires migrating all handlers to `addEventListener`. The E2E
  suite (below) already caught and fixed one real CSP defect (Google Fonts blocked); it would catch
  further regressions in whatever resource paths the test's page load exercises, but not a full audit.
- **In-browser E2E**: `dvb-i-receiver/test/e2e.test.js` runs a real headless Chromium (Playwright) —
  loads the app, fetches a compliant fixture list, and verifies channel rendering/selection. This is a
  smoke test, not full coverage: dash.js/hls.js playback (DVR window, track selection, DRM) is not
  exercised because it needs real media segments, which the fixture's placeholder URLs don't provide.
- **Parental control is advisory** (client-side PIN in localStorage); it cannot be made tamper-proof
  in a browser-only receiver.

## Subscription gating (behaviour note)

`ServiceRestriction` was removed (not a real DVB-I element). Subscription/CA gating is expressed via
`SubscriptionPackage` inside `ServiceInstance` (the spec mechanism). Set a Subscription Package in the
admin to gate a service; the receiver gates playback when a package is present.
