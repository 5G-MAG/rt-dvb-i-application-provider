# Changelog — dvb-i-admin

## 2026-07 (cont. 2) — Removed bundled third-party XSD schemas

- **Removed all 43 XSD schema files** that had been copied into `test/schemas/` from the GitHub repo
  `paulhiggs/dvb-i-tools` (BSD 2-Clause) for the XSD conformance test added below. They were copied
  without the license's required copyright notice initially; on review, rather than just add the
  missing attribution, the files were removed from the repository entirely to avoid redistributing
  third-party schema content at all.
- `test/xsd-validate.js` (`npm run test:xsd`) is now bring-your-own-schema: it looks for a local,
  gitignored `test/schemas/` directory and skips cleanly (exit 0) if absent, so `npm test` and CI stay
  green without it. See the file's header comment for what to place there to re-enable it locally.
- The one real bug this validation caught while it was in place — `AccessibilityAttributes` needing to
  be an unprefixed DVB-I element — is unaffected by this change; that fix lives in `server.js` and
  doesn't depend on the schema files being present. See COMPLIANCE.md for the historical record of
  what was validated and when.

## 2026-07 (cont.) — Machine-checked compliance, CS terms, ops hardening, testing

- **Machine-checked XSD validation**: installed `libxmljs2` and validated the generated output against
  the real schemas — caught one more bug the manual audit missed: `AccessibilityAttributes` must be an
  unprefixed DVB-I element (its TYPE is `tva:AccessibilityAttributesType`, but the element itself is not
  in the tva namespace). Fixed. `npm test` now runs this validation on every change (see COMPLIANCE.md).
- **Classification-scheme terms corrected** against the DVB/TVA CS registries (XSD validates the URI
  syntax but not scheme membership): `ServiceTypeCS` `ondemand` (not the non-existent `nonlinear`);
  `ContentCS:2011` hierarchical termIDs (not the non-existent `ContentCS:2019:X.0.0` form);
  `SubtitlePurposeCS:2023:2` (not the non-existent `:2009:HardOfHearing`).
- **Ops hardening**: atomic config writes (write-temp-then-rename, prevents corruption on crash/race);
  config shape validation on load and on every write; in-memory rate limiting on mutating/proxy routes
  (429 after the window); structured JSON-lines logging (`LOG_LEVEL` env var); optional native HTTPS
  via `HTTPS_KEY_PATH`/`HTTPS_CERT_PATH` (falls back to HTTP on missing/invalid cert).
- **Testing**: `test/server.test.js` — unit tests for `msDur`, `buildSchedule`, and semantic assertions
  on `buildServiceList` (no removed elements, correct element nesting, real CS terms, multi-DRM). CI
  workflow (`.github/workflows/test.yml`) runs the full suite on every push/PR.
- Removed the dead `Service Restriction`/`Original Delivery Source` admin UI fields entirely (no longer
  even stored) now that no code path references them.

## 2026-07 — Schema compliance, security, tooling

### Compliance (generator now validates against the official XSDs)
- Fixed 26 service-list/EPG schema violations found by auditing against `dvbi_v6.0-with-hls-hbbtv.xsd`
  and `tva_metadata_3-1_2024.xsd`, including:
  - Removed elements not in the schema: `ServiceRestriction`, `TargetCountry`, `OriginalDeliverySource`;
    `NowNextInfoEndpoint` replaced by `ProgramInfoEndpoint`.
  - Moved `SubscriptionPackage` and `Availability` from `Service` into `ServiceInstance` (correct sequence).
  - `LCNTable`/`TargetRegion` emitted as child elements; added required `RegionList/@version` and
    `Region/@countryCodes`; `URI` qualified into `servicediscovery-types:2023` (`dvbisd-t:` prefix).
  - `AccessibilityAttributes` in the DVB-I namespace (children stay `tva:`), correct child order and
    required children (`Carriage`, `Coding`, `SubtitleLanguage`, `Purpose`, `SuitableForTTS`; `AudioAttributes`).
  - EPG: `mpeg7` namespace `urn:tva:mpeg7:2008`; `BasicDescription` child order; `MemberOf` as a
    `ProgramInformation` child; `GroupInformation` order + `GroupType` via `xsi:type`/`@value`;
    `Free` as `@value`; CRIDs match the `tva:CRIDType` pattern; `IPMulticastAddress` `Address`/`Port`.
- Corrected classification-scheme terms to real registry members: `ServiceTypeCS:2019` (`ondemand`,
  not `nonlinear`), `ContentCS:2011` (hierarchical termIDs), `SubtitlePurposeCS:2023:2`.
- Multi-DRM (`ContentProtection` per system), ClearKey UUID, `SubtitleCarriage` type.

### Security
- Optional bearer-token auth (`ADMIN_TOKEN`) on all config/mutating/proxy routes; public read routes open.
- SSRF guard on `/api/test-url` and `/api/fetch-xml` (blocks private/loopback/link-local + cloud metadata).
- `xe()` escapes `'`; numeric attributes escaped; prototype-pollution key reject on config write/restore.
- Fixed DOM XSS in the import preview and logo `onerror` handlers.
- Conditional GET: `Last-Modified` + `If-Modified-Since`/`304`, bumped on every config write.

### Tooling
- `npm test` (`test/xsd-validate.js`) validates generated output against the bundled XSDs via `libxmljs2`.
- `server.js` exports its builders and only listens when run directly (testable).

### UI
- Removed dead fields (Service Restriction, Original Delivery Source). Subscription gating is now via
  Subscription Package. Target Country also drives Region `countryCodes`.
- Multi-DRM authoring; subtitle carriage type; linked-application URL.

See COMPLIANCE.md and DEPLOYMENT.md.
