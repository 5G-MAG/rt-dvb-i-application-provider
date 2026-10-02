# Changelog — rt-dvb-i-application-provider

## 2026-10 — Service list content (ETSI TS 103 770 V1.2.1)

- **`SubscriptionPackageList`** is written whenever an instance carries a subscription package,
  listing each package once (clause 5.1.5).
- **Logos are JPEG or PNG.** A service's logo is signalled only when it is `image/jpeg` or
  `image/png` (clause 5.2.6.2); the SVG letter placeholder is no longer put in the list, an unknown
  type is no longer labelled `image/png`, and uploads accept PNG and JPEG only.
- **`image_variant`** outside table 8 is answered 400 on every endpoint; a valid one gets no logo
  and no programme image, since no variants exist (clause 5.2.8.2.1).
- **One service name per language code**: a repeated or empty code is refused on save (clause 5.2.10).
- **`LanguageList`** holds the audio languages set per service (new *Audio Languages* field), not
  the languages of the names (table 14); service `ProviderName` carries `@xml:lang` (table 15).
- **One applicable LCN table per region.** With regional services there is no table without
  `TargetRegion`; each region's table also numbers the services that target no region (clause 5.5.12).
- **Region `@countryCodes`** is the configured target country, never a code made from the region
  identifier; publishing regional services without one is refused (table 38).
- **Server-side Region Selection by regionID**: `?region=<regionID>` returns the list tailored to
  that region with `@responseStatus` (`OK`, `ERROR_INVALID_REGION_ID`, `ERROR_INVALID_REQUEST`),
  clauses 5.6.4.4 and 5.6.4.5.

## 2026-10 — Publication and versioning (ETSI TS 103 770 V1.2.1)

- **The service list is served as `application/vnd.dvb.dvbisl+xml`**, the media type clause 5.1.2
  requires, instead of `application/xml`.
- **Every publish increments `@version`.** Logo upload, logo removal and history restore now
  publish under a new list `@version` (and so a new `RegionList@version`), and any service whose
  `Service` element changed gets a new `Service@version`, whichever path published it. A restored
  copy moves numbers forward, never back.
- **`@priority` is never written as `undefined`.** An instance without a priority is written
  without the attribute (schema default 0); a priority that is not a non-negative integer is
  refused on save with a 400.
- **A `UniqueIdentifier` is published once.** Save and history restore refuse two enabled services
  with the same identifier (clause 5.1.4), and *Clone* gives the copy its own.

## 2026-10 — 5G Broadcast instances without a local extension

- **A 5G Broadcast instance is `IdentifierBasedDeliveryParameters` holding its `mbms://` URL.** It
  was emitted as `OtherDeliveryParameters` with a 5G-MAG `xsi:type`
  (`urn:5g-mag:metadata:dvbi-5g:2026`). ETSI TS 103 770 V1.2.1 table 16 already defines an element
  for "An identifier in the form of a locator (URL)", so the list now validates against the
  published schema alone. `schemas/dvbi-5g-ext-1.0.xsd` is removed, and with it the service class
  and unicast fallback fields: the class belongs in the User Service Description (clause 9.3.1), and
  a unicast copy is another instance with a lower priority.
- **The `mbms://` URL is checked on save** against 3GPP TS 26.347 V18.1.0 clause 8.2.2; an invalid
  one is refused with a 400.

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
