# DVB-I / TV-Anytime Compliance Status

Last verified: 2026-09-07.

## Baseline

The generator targets **ETSI TS 103 770 V1.2.1 (2024-09)**, "Service Discovery and Programme
Metadata for DVB-I". That issue is what the emitted namespaces belong to
(`urn:dvb:metadata:servicediscovery:2024`, `urn:dvb:metadata:servicediscovery-types:2023`,
`urn:tva:metadata:2024`), which is how the version was determined rather than chosen.

**V1.2.1 is the current published issue.** Checked 2026-09-08 against the DVB Project's own
standards page for this specification, which lists `TS 103 770 V1.2.1` dated 05.09.2024 as the
published standard and `DVB BlueBook A177r8 (Draft TS 103 770 V1.3.1)` dated 30.06.2026 as the
latest draft. So the baseline is not merely the issue we happen to hold: it is the newest one
published.

A177 Rev.8, the draft of V1.3.1, moves to `:2026` namespaces throughout. It is **not** the baseline
here and output has not been checked against it. Adopting it would be a deliberate migration to a
new namespace and schema version, made when it is published, not a correction to make now.

**Secondary reference.** DVB Document A184r2, "Implementation Guidelines for DVB-I" (July 2025), is
guidance for client implementers rather than a normative format specification. Every citation of it
in `server.js` was checked against the document on 2026-09-08, and three of the five were wrong:

- LCN tables were attributed to its clause 4.8, which is "Region targeting"; the LCN guidance is in
  clause 4.3, and in any case it describes what a *client* does with LCN tables, not how a list is
  generated. Now cited to what actually governs the output: TS 103 770 V1.2.1 clause 5.5.12,
  table 25, row TargetRegion.
- The linked application was attributed to its clause 5.1, which is a general note on application
  technologies. The requirement is TS 103 770 V1.2.1 clause 5.2.3.1.
- Conditional GET was attributed to TS 103 770 clause 4.3.3.7, which is the back-off algorithm.
  If-Modified-Since is clause 4.3.2.2.

The two remaining citations, clause 4.5 (Interpreting Program Schedules) and clause 4.11 (Channel
list updates), are correct and are kept.

## What is validated, and how

**This project does not bundle or redistribute the ETSI/DVB XSD schema files, and no schema has
ever been committed to it.** XSD validation (`test/xsd-validate.js`, `npm run test:xsd`) is opt-in
and bring-your-own-schema. Point `DVBI_SCHEMAS` at a directory holding the closure and keep that
directory outside this working tree, so the files cannot be committed whatever `.gitignore` says:

```bash
DVBI_SCHEMAS=~/.local/share/dvb-i-schemas/etsi npm run test:xsd
```

Without it the run skips cleanly (exit 0), so `npm test` stays green either way.

**Where the authoritative schemas come from.** They ship with the specification. ETSI TS 103 770
V1.2.1 (2024-09) annex B (normative), "Electronic Attachments", lists `dvbi_v6.0.xsd`,
`dvbi_types_v1.0.xsd`, `tva_metadata_3-1.xsd` and `tva_mpeg7.xsd` among the contents of the archive
`ts_103770v010201p0.zip` that accompanies the document, along with the classification scheme files.
The one file that closure needs and does not contain is W3C's `xml.xsd`.

The run prints which schema files it used, because a conformance result says nothing without it.

| Output | Namespace | Schema (if you supply it locally) |
|---|---|---|
| Service list | `urn:dvb:metadata:servicediscovery:2024` | `dvbi_v6.0-with-hls-hbbtv.xsd` (+ import closure) |
| EPG (schedule / now-next) | `urn:tva:metadata:2024` | `tva_metadata_3-1_2024.xsd` (+ `tva_mpeg7.xsd`) |

**Verification run 2026-09-08, against the specification's own electronic attachment.** The
generated list, both shipped templates and both EPG endpoints are VALID against `dvbi_v6.0.xsd` and
`tva_metadata_3-1.xsd` as published in `ts_103770v010201p0.zip`.

One document is reported as not checked rather than valid: the comprehensive test fixture carries an
HLS delivery instance, and HLS signalling is described in annex G, which is informative, so its
schema extension is not part of the normative attachment. Against the base schema its `xsi:type`
does not resolve and the element's own type is abstract. Checking it needs a composed schema that
folds the HLS extension in, which third-party DVB-I tooling publishes; against such a closure it is
VALID. Nothing in the demo or the templates depends on this, all of which are DASH only.

**A composed third-party schema is not the authority.** The earlier run below used one, and its
TV-Anytime schema turns out to differ from the published file in two substantive places, both
laxer: `Purpose` is `maxOccurs="unbounded"` where the published schema allows one, and
`ScheduleEvent` is `minOccurs="0"` where the published schema requires at least one. Neither
weakens the results recorded here, because this generator emits exactly one `Purpose` and never an
empty `Schedule`, but a validation pass against a mirror is worth less than one against the
attachment, and the difference was only visible once both were on disk.

**Verification run 2026-09-07.** XSD validation was run again with the schema closure supplied
locally, and now covers four things rather than one: the comprehensive sample list, the live
`config.json`, every file in `templates/`, and both EPG endpoints. All pass. It found two real
defects, both since fixed:

1. **`TVAMain` emitted without `@xml:lang`.** The empty documents returned when a service had no
   programmes, and when no service matched the requested `sid`, omitted the attribute that
   `tva_metadata_3-1_2024.xsd` marks `use="required"` on `TVAMainType`. TS 103 770 V1.2.1 clause
   6.10.1.2 states the same obligation in prose. The populated responses were always correct; only
   the empty ones were not, which is why manual reading had missed it.
2. **Absolute `logoUrl` values were concatenated onto the base URL**, producing a `tva:MediaUri` of
   the form `http://hosthttp://host/...`, which is not a valid `xs:anyURI`. The editor's own "Logo
   Image URL" field invites an absolute URL, so this was reachable straight from the UI. Relative
   values (what the logo upload stores) were unaffected. The generator now resolves only the
   relative form against the base.

A third issue was found in data rather than code and is worth knowing about when composing a list:
**`ContentGuideSource/@CGSID` is typed `xs:ID`**, so it must be an NCName and cannot begin with a
digit. The provider does not currently reject a non-conformant value on entry, so an id such as
`5g-mag-epg` is accepted by the editor and produces a list that fails schema validation. See
"Known limitations" below.

**Historical note (2026-07-01):** during development, this generator's output WAS machine-validated
against the real schemas (sourced temporarily from the `paulhiggs/dvb-i-tools` GitHub repo, BSD
2-Clause) and confirmed fully valid (structure, sequence order, cardinality, datatypes, namespaces).
That one-time validation run caught one violation a manual audit against the schema text had missed —
`AccessibilityAttributes` must be an unprefixed DVB-I element (its content TYPE is
`tva:AccessibilityAttributesType`, but the element itself is declared in the DVB-I namespace, not
TVA). That fix is in `server.js` and the receiver/importer parsers and does not depend on the schema
files being present. The schema files themselves were removed from this repository and are not
redistributed here — see CHANGELOG.md for context.

## Delivery over 5G

What it would take to carry these services over a 5G system, which of ETSI TR 103 972's fourteen
gaps are still open, and what is already specified: see `DVB-I-OVER-5G.md` beside this file. In
short, seven of the fourteen are closed, the 5G Broadcast locator fits an existing element, and the
ones that block work here are the missing elements for 5GMS access information.

### 5G Broadcast instances use IdentifierBasedDeliveryParameters

A service instance delivered over MBMS (5G Broadcast) is emitted as
`<IdentifierBasedDeliveryParameters>mbms://…</IdentifierBasedDeliveryParameters>`, with no
extension and no namespace of our own, so the list validates against the published schema alone.

ETSI TS 103 770 V1.2.1 clause 9.3.3: "When a DVB-I service instance with an mbms:// locator is
selected by the user, the DVB-I client (acting as an MBMS-Aware Application) shall invoke the MBMS
Client to initiate reception of the corresponding MBMS User Service."
It does not name the element. Clause 5.5.4, table 16, row `IdentifierBasedDeliveryParameters`: "An
identifier in the form of a locator (URL) or name (URN) that contains the parameters of the relevant
delivery system for this service instance."
Annex G.2.3 uses the element the same way for HLS. **That is our reading, not a sentence of the
specification**: no clause says to use this element for MBMS.

- `@contentType` is left out. Table 33a allows that when the payload type can be "determined through
  some component of the element value", here the `mbms` scheme.
- The URL is checked on save against 3GPP TS 26.347 V18.1.0 clause 8.2.2 (scheme, authority, no
  mid-part pairs except the Receive-only Mode form of clause 8.2.4, `&label=` suffix a URI). Its
  prefix must equal the User Service's `serviceId`, which only the BM-SC knows and is not checked.
- The service class of table 106 is set in the User Service Description (clause 9.3.1), on the
  BM-SC, not in the service list.
- A unicast copy of the same service is another instance with a lower `@priority`.

An earlier version carried the locator in a 5G-MAG extension (`urn:5g-mag:metadata:dvbi-5g:2026`,
`OtherDeliveryParameters` with a private `xsi:type`). It was withdrawn because the existing element
covers the locator.

## Classification-scheme terms

CS `@href` values are typed `anyURI` by the schema, so XSD validation cannot check CS membership: a
schema-valid document can still name a term that does not exist. `npm run test:cs`
(`test/cs-validate.js`) closes part of that gap by checking every emitted term against the scheme
files themselves, which ship in the same electronic attachment archive as the schemas.

As of 2026-09-08: **all 38 terms checked across the sample list, the live config, both templates
and both EPG endpoints are present in their schemes. None is unchecked.**

That covers both publishers' schemes. The DVB ones come with TS 103 770's archive; the TV-Anytime
ones (`ContentCS:2011`, `HowRelatedCS:2012`, `SubtitleCarriageCS:2023`,
`SubtitleCodingFormatCS:2023`, `SubtitlePurposeCS:2023`) are published with **ETSI TS 102 822-3-1**,
whose own attachment archive `ts_1028220301v011301p0.zip` (V1.13.1, 2024-05) carries them. Put both
sets in the directory `DVBI_SCHEMAS` names.

The coverage was checked by mutation rather than assumed: introducing a `SubtitlePurposeCS` term
and a `ContentCS` termID that do not exist makes the run name the offending term and fail, and
reverting restores the pass. This matters because `ContentCS` is where one of the three historical
CS defects was, and it had been resting on a one-off manual check until now.

The emitted terms were originally verified by hand against the DVB/TVA CS registries and corrected
where wrong:

- `ServiceTypeCS:2019` — `linear`, `linear-radio`, `ondemand` (was the non-existent `nonlinear`).
- `ContentCS:2011` — hierarchical termIDs, e.g. `3.1.1` News, `3.2` Sports, `3.4` Fiction/Drama,
  `3.5` Entertainment, `3.6` Music (was `ContentCS:2019` with non-existent `X.0.0` terms).
- `SubtitlePurposeCS:2023:2` = Hard of hearing (was the non-existent `:2009:HardOfHearing`).
- `SubtitleCarriageCS:2023`, `SubtitleCodingFormatCS:2023:2.1.3`, `LinkedApplicationCS:2019:1.1`,
  `HowRelatedCS:2021:1001.2` (service logo), `HowRelatedCS:2012:19` (promo image) — all verified.

## Known limitations / not done

- **Server-side Region Selection supports the regionID method only** (`?region=<regionID>`, ETSI
  TS 103 770 V1.2.1 clause 5.6.4.4), which is one of the two methods clause 5.6.4.1 accepts. The
  postcode method needs postcode data on regions, which the editor does not hold, and the
  receivable multiplex method is optional; requests using either are answered with the untailored
  list and no `@responseStatus`. Advertising the method in `SRSSupport` is the registry entry's job
  (it sits in the `ServiceListOffering`). The provider's own `TargetCountry` query parameter is
  not a method of clause 5.6.4 and carries no `@responseStatus`.
- **Region `@countryCodes` is checked for format only.** It is the list's configured target country
  (`[A-Z]{3}`, comma-separated), required on publish when services have target regions; whether a
  code is assigned in ISO 3166 is not checked.
- **TLS profile not checked.** The server serves TLS 1.2 and 1.3 (ETSI TS 103 770 V1.2.1 clause 7.3)
  and does not start without a certificate unless `PLAIN_HTTP` is set; the cipher suites, signature
  algorithms, key sizes and curves clause 7.3 takes from ETSI TS 102 796 clause 11.2 are not
  configured, since that document is not held. `PLAIN_HTTP=private-subnet` does not verify that
  clients are on the same private subnet.
- **On-demand programmes: what the content deep-linked XML AIT does and does not cover.**
  ETSI TS 103 770 V1.2.1 clause 6.10.8.2, table 52, row ProgramURL: "A URL location of a content
  deep-linked XML AIT for the on-demand programme." `ProgramURL` points to `/ait/program.aitx`
  with `@contentType` `application/vnd.dvb.ait+xml`; the XML AIT carries the operator's
  `catchupPlayer` values and is VALID against `xmlait/mis_xmlait.xsd` (`npm run test:xsd`).
  Limits:
  - **Platform profile and version** are checked against ETSI TS 102 796 V1.8.1 (2026-09) clause
    7.2.3.1, table 5, row "5.2.5 Platform profiles". Clause 5.2.4.2 cites it as reference [21],
    which is undated, so the latest issue applies; V1.8.1 is that issue as of 2026-10-02. A later
    issue that adds a version needs the list in `server.js` extended.
  - **`version` of an HbbTV application**: TS 102 796 table 7 replaces its type with
    `mhp:unsignedInt31Bit`, which is not defined in the schemas held; only the `ipi:Version` form
    of `mis_xmlait.xsd` (two hexadecimal digits) is checked.
  - **`orgId`** is checked for range only; whether it is registered with DVB is not.
  - **No `application/vnd.dvbi.non` XML AIT.** Clause 5.2.4.2 requires one where the provider "is
    unable to provide a suitable application based on device specific information". This provider
    never tailors the application to the device, so the case does not arise; the contextual
    parameters are accepted and ignored.
  - **The deep link is a query parameter.** Clause 5.2.4.3 leaves the form of `applicationLocation`
    "at the discretion of the Content Provider"; this provider always appends the catch-up URL as
    the configured parameter, so a player expecting it elsewhere (for example in the path) cannot
    be configured.
  - **`AuxiliaryURL` (Template XML AIT) is not written.** The specification is inconsistent on
    whether it must be: table 52, row AuxiliaryURL, marks it "Optional {0..1}", while clause
    5.2.4.4.2 reads "Within every OnDemandProgram element supplied through the content guide
    interface there shall be an AuxiliaryURL referencing a Template XML AIT." Left out until that
    is resolved.
- **A known service with no event in the requested period gets an empty TV-Anytime document.**
  Clause 6.5.4.1 asks for "an empty Schedule element", but `tva_metadata_3-1.xsd`, attached to the
  same specification, requires at least one `ScheduleEvent` in a `Schedule`. The two cannot both be
  met; the behaviour is unchanged until that is resolved.
- **A service without a JPEG or PNG logo is published without a logo.** Clause 5.2.6.2 requires at
  least one logo of those types; the generated letter placeholder is SVG, so it is shown in the
  editor but not signalled in the list. Uploads are limited to PNG and JPEG.

- **An existing `@CGSID` that `xs:ID` forbids is not migrated.** A write that would introduce one
  is now rejected with a message naming the value and the rule, but a list that already carries a
  bad identifier still loads, with a warning at startup. It is not rewritten silently, because
  every `ContentGuideSourceRef` pointing at it would break; correcting it is the operator's call.
- **Two moderate dependency advisories remain open, and cannot be closed without a breaking
  upgrade.** Express 4.22.2 pins `qs` to `~6.15.1`; the advisories are fixed in `qs` 6.16.0, which
  that range excludes, and 4.22.2 is the last release of the 4.x line. Only Express 5 resolves it.
  Both affect query string parsing, which this server does reach, so the exposure is real rather
  than theoretical. `npm audit` reports them on every run; they are left rather than forced,
  because `npm audit fix --force` would move a major version under a test suite that has not been
  run against it.
- **Neither conformance check runs in CI.** `npm run test:xsd` and `npm run test:cs` both need
  files this project does not carry and may not redistribute, so CI runs the unit tests and those
  two skip with exit 0. Closing this would mean CI fetching the specifications at run time on every
  push, which is a decision about somebody else's servers rather than a code change. Both run
  locally against `DVBI_SCHEMAS`.
- **FairPlay DRM** is signalled but cannot fully work under this schema version: the license/certificate
  attributes (`DRMSystemId/@LAURL`, `@certificateURL`) exist only from DVB-I **v8.0**; the generator
  targets v6.0 (`servicediscovery:2024`). The receiver surfaces a clear error instead of failing
  opaquely. Full FairPlay would require migrating to the v8.0 schema.
- **Strict CSP** — the receiver CSP still allows `'unsafe-inline'` for scripts because the UI uses
  inline event handlers. Dropping it requires migrating all handlers to `addEventListener`. The E2E
  suite (below) already caught and fixed one real CSP defect (Google Fonts blocked); it would catch
  further regressions in whatever resource paths the test's page load exercises, but not a full audit.
- **In-browser E2E**: `rt-dvb-i-application/test/e2e.test.js` runs a real headless browser
  (Playwright), Chromium by default and any engine via `BROWSER`; some environments cannot run
  Chromium at all and need `BROWSER=firefox` —
  loads the app, fetches a compliant fixture list, and verifies channel rendering/selection. This is a
  smoke test, not full coverage: dash.js/hls.js playback (DVR window, track selection, DRM) is not
  exercised because it needs real media segments, which the fixture's placeholder URLs don't provide.
- **Parental control is advisory** (client-side PIN in localStorage); it cannot be made tamper-proof
  in a browser-only receiver.

## Subscription gating (behaviour note)

`ServiceRestriction` was removed (not a real DVB-I element). Subscription/CA gating is expressed via
`SubscriptionPackage` inside `ServiceInstance` (the spec mechanism). Set a Subscription Package in the
admin to gate a service; the receiver gates playback when a package is present.
