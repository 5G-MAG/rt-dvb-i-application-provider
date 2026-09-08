# Changelog — rt-dvb-i-application-provider

## 2026-09 (cont.) — Security hardening

- **Uploaded logos cannot execute.** SVG is among the accepted image types, and uploads are served
  from this origin, so an uploaded SVG carrying a `<script>` would run if a browser navigated to it
  directly. It never does as an `<img>` source, which is how the editor and the generated list use
  it, but nothing stopped someone opening the URL. Uploads are now served with
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` and
  `X-Content-Type-Options: nosniff`, which makes the file inert whatever it contains. This matters
  most in the default configuration, where `ADMIN_TOKEN` is unset and the upload endpoint is
  therefore unauthenticated.

- **The admin token is compared in constant time.** A plain `===` returns as soon as two bytes
  differ, so response timing leaks how much of the token was correct, one byte at a time. The
  length check is kept separate and first, since the length is not the secret.


## 2026-09 — Templates, EPG and logo URL conformance fixes

**Conformance fixes** (both found by running `npm run test:xsd` with the schema closure supplied
locally; see COMPLIANCE.md for the full record):

- **`TVAMain` without `@xml:lang`.** `/epg/schedule` and `/epg/nownext` returned empty TV-Anytime
  documents that omitted `@xml:lang`, which `TVAMainType` marks required. Fixed, and the two empty
  responses now come from one helper so the attribute cannot be forgotten again.
- **Empty EPG answered with 404.** A service that exists but carries no programmes was answered
  with 404, which per TS 103 770 V1.2.1 clause 4.3.3.4 makes a client re-acquire the whole service
  list and then apply the back-off model of clause 4.3.3.7. It is now an empty but valid document
  with 200. 404 is kept for a `sid` that names no service in the list, which is the case that
  clause actually describes.
- **Absolute `logoUrl` corrupted.** An absolute logo URL, which the editor's own "Logo Image URL"
  field invites, was concatenated onto the base URL and emitted as
  `http://hosthttp://host/...`, not a valid `xs:anyURI`. Only relative values are resolved against
  the base now.

**Templates.** A `templates/` directory of ready-made starting points, offered by a selector next
to *+ Add Service* and loaded with the button beside it. Two kinds, set by each file's own `kind`:

- `service` opens the editor pre-filled with one service. `service-template.json` ships a reference
  service with every supported field populated, delivered over DASH.
- `list` replaces the whole line-up, after asking. `dvbi-local-live-demo.json` ships the DVB-I live
  demo's channels, generated from that demo's own `channels.json`.

Served by `GET /api/templates` and `GET /api/templates/:file`, read from disk on each request, so
adding or editing a file changes what the selector offers without a restart. Loading a service
template twice does not collide: the second copy gets a distinct `id` and `uid`, its instance ids
follow, and it takes the next free LCN. Nothing is stored until the operator saves and publishes.

**`config.json` is no longer tracked.** It is the live service list, rewritten by the server on
every publish, so keeping it in version control meant every publish showed as a source change and a
fresh clone shipped whatever list the last committer happened to have. `config.example.json` is
tracked instead and is copied into place on first start, so a clean checkout still runs.

**A ContentGuideSource identifier that `xs:ID` forbids is now rejected on write**, with a message
naming the value and the rule, instead of publishing a list that fails schema validation.

**Editor hint on multi-language names.** The *Multi-language Service Names* section now says that
its entries replace the Service Name in the published list. They always did: `ServiceName` is built
from them whenever a service has any, so renaming a service while leaving a stale entry behind
produced a list that still carried the old name, with nothing on screen explaining why.

**Testing.** `npm run test:xsd` now validates the live `config.json` and every file in `templates/`
in addition to the comprehensive sample and the EPG endpoints, so a template that would produce an
invalid list fails in the test rather than when someone loads it.

**Renamed** from `dvb-i-admin` to `rt-dvb-i-application-provider`, alongside `dvb-i-client` becoming
`rt-dvb-i-application`.

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
