<p align="center">
  <img src=".github/banner.svg" width="100%" alt="Reference Tools · DVB-I Services over 5G Systems: DVB-I Application Provider">
</p>

<p align="center">
  Publishes a DVB-I service list and its content guide, and gives an editor for maintaining them,
  per ETSI TS 103 770.
</p>

<p align="center">
  <img alt="Status: under development"
    src="https://img.shields.io/badge/Status-Under_Development-yellow">
  <a href="https://github.com/5G-MAG/rt-dvb-i-application-provider/releases"><img alt="Version"
    src="https://img.shields.io/github/v/release/5G-MAG/rt-dvb-i-application-provider?label=Version&sort=semver"></a>
  <a href="LICENSE"><img alt="License: 5G-MAG Public License v1.0"
    src="https://img.shields.io/badge/License-5G--MAG%20PL%20v1.0-blue"></a>
</p>

<p align="center">
  <a href="https://www.5g-mag.com/reference-tools/dvb-i">Project page</a> &nbsp;&middot;&nbsp;
  <a href="https://github.com/5G-MAG/rt-dvb-i-application-provider/issues">Issues</a> &nbsp;&middot;&nbsp;
  <a href="https://www.5g-mag.com/contributing">Contributing</a>
</p>

---

## At a glance

|  |  |
|---|---|
| **Implements** | ETSI TS 103 770 V1.2.1 (2024-09), *Digital Video Broadcasting (DVB); Service Discovery and Programme Metadata for DVB-I* |
| **Serves** | `/service-list.xml`, `/epg/schedule`, `/epg/program`, `/ait/program.aitx` (XML AIT per on-demand programme), an admin UI on `/` |
| **Part of** | [DVB-I Services over 5G Systems](https://www.5g-mag.com/reference-tools/dvb-i), alongside [rt-dvb-i-application](https://github.com/5G-MAG/rt-dvb-i-application) (the receiver), [rt-dvb-i-service-list-registry](https://github.com/5G-MAG/rt-dvb-i-service-list-registry) (discovery), [rt-dvb-i-examples](https://github.com/5G-MAG/rt-dvb-i-examples) (runnable demos) and [rt-5gms-application](https://github.com/5G-MAG/rt-5gms-application) (the Exo DVB-I Player) |

## Introduction

This repository is two of the components in the DVB-I architecture of TS 103 770 clause 4.1. The
Service List Server, in that clause's words: "One or more servers delivering Service Lists to a DVB-I
client." The Content Guide Server: "These respond to requests from a DVB-I client for content guide
data."

The editor on `/` is not part of that architecture. It exists so the list can be maintained without
hand-editing XML.

A DVB-I client finds this server through a Service List Registry, which is a separate component and
a separate repository.

## Specification

Built against **ETSI TS 103 770 V1.2.1 (2024-09)**, a version rather than a release name.
[COMPLIANCE.md](COMPLIANCE.md) records what is conformant, against which issue, and what is not.

Clause-by-clause coverage, and what is still absent, is recorded on the project page:
<https://www.5g-mag.com/reference-tools/dvb-i>

## Running

```bash
npm install
HTTPS_KEY_PATH=key.pem HTTPS_CERT_PATH=cert.pem npm start   # https://localhost:4000
PLAIN_HTTP=private-subnet npm start                         # http://localhost:4000
```

The service list and content guide are served over TLS (ETSI TS 103 770 V1.2.1 clause 7.3), so the
server does not start without a certificate unless `PLAIN_HTTP` says why plain HTTP is allowed:
`private-subnet` when clients are on the same private subnet, `behind-tls-proxy` when a reverse
proxy terminates TLS. See [DEPLOYMENT.md](DEPLOYMENT.md).

The CI workflow runs on Node.js 20; the `Dockerfile` builds on `node:22-alpine`.

## Configuration

The service list is `config.json`, created from `config.example.json` on first start. Editing it
through the UI and pressing *Save & Publish* rewrites that file and bumps the list version, which
tells a receiver to re-read it.

[DEPLOYMENT.md](DEPLOYMENT.md) covers environment variables, HTTPS, and what to set before the server
is reachable from anywhere but your own machine. Note that `ADMIN_TOKEN` is unset by default, which
leaves the admin API and the logo upload open to anyone who can reach the port.

## Templates

`templates/` holds ready-made starting points offered by the editor: a reference service with every
supported field populated, and the channel line-up of the live demo. Files are read on each request,
so adding one changes what the editor offers without a restart.

## Catch-up (on-demand programmes)

A programme with a catch-up URL is offered on demand. Its `OnDemandProgram/ProgramURL` is not the
stream: it is the URL of a content deep-linked XML AIT, `/ait/program.aitx?pid=<programme CRID>`,
with `@contentType` `application/vnd.dvb.ait+xml` (ETSI TS 103 770 V1.2.1 clause 6.10.8.2, table 52).
That XML AIT launches your catch-up player at `URL Base` + `Location`, with the programme's catch-up
URL in the query parameter you name, and is served as `application/vnd.dvb.ait+xml`.

Enter the player in the editor's *Catch-up Player (XML AIT)* card (`catchupPlayer` in `config.json`):
domain name, application name and its ISO 639-2 language, organisation and application IDs,
application type, control code, optional visibility and service bound, priority, version, platform
profile and version, URL base, location and the parameter name. None of these has a default.

- **A catch-up URL without a usable player is refused on save**, naming the field and the clause.
  Clause 6.5.4.1 requires an `OnDemandProgram` for an on-demand programme, and table 52 makes its
  `ProgramURL` mandatory and an XML AIT, so the provider cannot publish one without the other.
  This includes the reference service template, whose second programme has a catch-up URL.
- **A list already on disk** that has catch-up URLs and no usable player still loads, with a
  warning; its programmes are published without `OnDemandProgram`, and `/ait/program.aitx`
  answers 404, as it does for any programme that is not on demand.
- The platform profile and version must be values of ETSI TS 102 796 table 5 (V1.8.1: profile 0 to
  3, version 1.1.1 to 1.8.1). An HbbTV player (`application/vnd.hbbtv.xhtml+xml`) must also meet
  TS 102 796 table 7: control code `AUTOSTART`, visibility `VISIBLE_ALL`, service bound false, a URL
  base ending in `/`, and a launch URL of at most 2 048 characters.
- The player has to accept the catch-up URL as that query parameter; the parameter cannot be
  `regionID[]` or `lloc`, which the client appends to the XML AIT URL (clause 5.2.4.4.6).

## 5G Broadcast instances

A service instance can be given the type **5G Broadcast** in the editor. It is emitted as
`IdentifierBasedDeliveryParameters` holding the `mbms://` URL of the MBMS User Service, which
ETSI TS 103 770 V1.2.1 clause 9.3.3 has the client hand to its MBMS Client. Table 16 defines that
element as an identifier "in the form of a locator (URL)" for "the relevant delivery system"; no
clause names it for MBMS, so this is a reading, recorded in COMPLIANCE.md. The URL is checked on
save against ETSI TS 126 347 clause 8.2.2. To offer the same service over unicast, add a DASH or
HLS instance with a lower priority.

## Development

```bash
npm test        # unit tests, XSD validation, classification scheme membership
npm run test:unit
```

The two conformance checks need schema and classification scheme files that this repository does not
carry and may not redistribute. Supply them through `DVBI_SCHEMAS`, from a directory outside the
working tree; without it they skip and `npm test` stays green. Both sets ship in the electronic
attachment archive accompanying TS 103 770.

## Documentation

- [COMPLIANCE.md](COMPLIANCE.md): what is conformant, against which issue, and what is not
- [DVB-I-OVER-5G.md](DVB-I-OVER-5G.md): what carrying these services over a 5G system would require
- [DEPLOYMENT.md](DEPLOYMENT.md): running it somewhere other than your laptop
- [CHANGELOG.md](CHANGELOG.md)

## Contributing

Contributions are welcome. How to raise an issue, fork the repository and open a pull request, and
the Contributor License Agreement required before code can be merged, are described at
<https://www.5g-mag.com/contributing>.

## License

Distributed under the 5G-MAG Public License v1.0. See [LICENSE](LICENSE).
