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
| **Part of** | [DVB-I Services over 5G Systems](https://www.5g-mag.com/reference-tools/dvb-i), alongside [rt-dvb-i-application](https://github.com/5G-MAG/rt-dvb-i-application) (the receiver), [rt-dvb-i-android-application](https://github.com/5G-MAG/rt-dvb-i-android-application) (the Android receiver), [rt-dvb-i-service-list-registry](https://github.com/5G-MAG/rt-dvb-i-service-list-registry) (discovery), [rt-dvb-i-examples](https://github.com/5G-MAG/rt-dvb-i-examples) (runnable demos) and [rt-5gms-application](https://github.com/5G-MAG/rt-5gms-application) (the Exo DVB-I Player) |

## Introduction

The DVB-I Service List Server and Content Guide Server: it publishes a DVB-I service list and its
content guide, and offers an editor on `/` to maintain the list without hand-editing XML. A DVB-I
client (`rt-dvb-i-application`, `rt-dvb-i-android-application`) finds it through a Service List
Registry (`rt-dvb-i-service-list-registry`).

## Specification

Built against **ETSI TS 103 770 V1.2.1 (2024-09)**.

What the specification defines, and what this repository implements and does not, is on the project
page: <https://www.5g-mag.com/reference-tools/dvb-i>

## Install dependencies

Node.js 20 or later, with npm. `openssl` to generate an admin token.

## Downloading

```bash
cd ~
git clone https://github.com/5G-MAG/rt-dvb-i-application-provider.git
```

## Building

```bash
cd rt-dvb-i-application-provider
npm install
```

## Running

```bash
npm install
npm start                                                   # http://localhost:4000, with a warning
HTTPS_KEY_PATH=key.pem HTTPS_CERT_PATH=cert.pem npm start   # https://localhost:4000
```

With neither `HTTPS_KEY_PATH` nor `HTTPS_CERT_PATH` set it serves plain HTTP and logs a warning; use
that only on a private subnet shared with the clients, for example a local demo. Behind a reverse
proxy that terminates TLS, set `PLAIN_HTTP=behind-tls-proxy`.

Before the server is reachable from anywhere but your own machine, set `ADMIN_TOKEN`: unset, it
leaves the admin API and the logo upload open to anyone who can reach the port.

```
ADMIN_TOKEN="$(openssl rand -hex 24)" npm start
```

The admin UI asks once for the token on the first `401`.

Published endpoints: `GET /service-list.xml`, `GET /epg/schedule?sid=<uid>&start=<unixtime>&end=<unixtime>`
or `&now_next=true|window`, `GET /epg/program?pid=<crid>` and `GET /ait/program.aitx?pid=<crid>`.

## Configuration

The service list is `config.json`, created from `config.example.json` on first start. Editing it
through the UI and pressing *Save & Publish* rewrites that file and bumps the list version, which
tells a receiver to re-read it.

`templates/` holds ready-made starting points offered by the editor: a reference service with every
supported field populated, and the channel line-up of the live demo. Files are read on each request,
so adding one changes what the editor offers without a restart.

A programme with a catch-up URL needs the editor's *Catch-up Player (XML AIT)* card filled in
(`catchupPlayer` in `config.json`); a list with catch-up URLs and no usable player is refused on save.
A service instance can be given the type *5G Broadcast*, with the `mbms://` URL of the MBMS User
Service.

| Variable | Default | What it sets |
|---|---|---|
| `PORT` | `4000` | port to listen on |
| `ADMIN_TOKEN` | unset | when set, `/api/*` requires `Authorization: Bearer <token>`. Unset, the admin API, including logo upload, is open to anyone who can reach the server. |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug`; logs are JSON lines on stdout and stderr |
| `HTTPS_KEY_PATH`, `HTTPS_CERT_PATH` | unset | PEM key and certificate; with both set the server serves HTTPS. Only one set, or a file that cannot be loaded, and the server does not start. Neither set: plain HTTP with a warning |
| `PLAIN_HTTP` | unset | `behind-tls-proxy`: plain HTTP behind a reverse proxy that terminates TLS, endpoint URLs in the list written `https://`. Not combined with `HTTPS_KEY_PATH`/`HTTPS_CERT_PATH` |
| `DVBI_SCHEMAS` | `test/schemas` | directory holding the XSD and classification scheme files, for `npm run test:xsd` and `npm run test:cs`. Keep it outside the working tree. Without it both checks skip and exit 0. |

## Development

```bash
npm test        # unit tests, XSD validation, classification scheme membership
npm run test:unit
```

The two conformance checks need schema and classification scheme files that this repository does not
carry and may not redistribute. Supply them through `DVBI_SCHEMAS`, from a directory outside the
working tree; without it they skip and `npm test` stays green. Both sets ship in the electronic
attachment archive accompanying TS 103 770. CI runs the tests from `.github/workflows/test.yml`.

## Contributing

Contributions are welcome. How to raise an issue, fork the repository and open a pull request, and
the Contributor License Agreement required before code can be merged, are described at
<https://www.5g-mag.com/contributing>.

## License

Distributed under the 5G-MAG Public License v1.0. See [LICENSE](LICENSE).
