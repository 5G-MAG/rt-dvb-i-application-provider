# DVB-I Application Provider

Publishes a DVB-I service list and its content guide, and gives an editor for maintaining them.

## At a glance

|  |  |
|---|---|
| **Implements** | ETSI TS 103 770 V1.2.1 (2024-09), see [COMPLIANCE.md](COMPLIANCE.md) |
| **Runs on** | Node.js 18 or newer |
| **Serves** | `/service-list.xml`, `/epg/schedule`, `/epg/nownext`, an admin UI on `/` |
| **Works with** | [`rt-dvb-i-application`](../rt-dvb-i-application) (the receiver), [`rt-dvb-i-service-list-registry`](../rt-dvb-i-service-list-registry) (discovery), [`rt-dvb-i-examples`](../rt-dvb-i-examples) (runnable demos) |

## Introduction

This is two of the components in the DVB-I architecture of TS 103 770 clause 4.1: the Service List
Server, which serves the list of services a client installs, and the Content Guide Server, which
answers that client's requests for schedule data. The editor on `/` is not part of the architecture;
it exists so the list can be maintained without hand-editing XML.

A DVB-I client finds this server through a Service List Registry, which is a separate component and
a separate repository.

## Running

```bash
npm install
npm start           # http://localhost:4000
```

The service list is `config.json`, created from `config.example.json` on first start. Editing it
through the UI and pressing *Save & Publish* rewrites that file and bumps the list version, which is
what tells a receiver to re-read it.

See [DEPLOYMENT.md](DEPLOYMENT.md) for environment variables, HTTPS, and what to set before this is
reachable from anywhere but your own machine. One thing worth knowing up front: `ADMIN_TOKEN` is
unset by default, which leaves the admin API and the logo upload open to anyone who can reach the
port.

## Templates

`templates/` holds ready-made starting points offered by the editor: a reference service with every
supported field populated, and the channel line-up of the live demo. Files are read on each request,
so adding one changes what the editor offers without a restart.

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

- [COMPLIANCE.md](COMPLIANCE.md) — what is conformant, against which issue, and what is not
- [DVB-I-OVER-5G.md](DVB-I-OVER-5G.md) — what carrying these services over a 5G system would require
- [DEPLOYMENT.md](DEPLOYMENT.md) — running it somewhere other than your laptop
- [CHANGELOG.md](CHANGELOG.md)

## License

No licence file has been added to this repository yet, so no licence is granted. Add one before
publishing or sharing it.
