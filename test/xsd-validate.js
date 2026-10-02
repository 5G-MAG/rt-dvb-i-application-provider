#!/usr/bin/env node
/*
License: 5G-MAG Public License (v1.0)
Authors: Jordi J. Gimenez (5G-MAG)
Copyright: (C) 2026 5G-MAG Association

For full license terms please see the LICENSE file distributed with this
program. If this file is missing then the license can be retrieved from
https://www.5g-mag.com/license
*/
/**
 * XSD conformance check for the DVB-I admin generator (optional, bring-your-own schemas).
 *
 * This project does NOT bundle or redistribute the ETSI/DVB XSD schema files (avoids any
 * question of redistribution rights for third-party schema files).
 *
 * Point DVBI_SCHEMAS at a directory holding the schema closure, and keep that directory OUTSIDE
 * this working tree, so the files cannot be committed by accident whatever .gitignore says:
 *
 *   DVBI_SCHEMAS=~/.local/share/dvb-i-schemas npm run test:xsd
 *
 * Without it, test/schemas/ is used, which is gitignored. Either way the files are yours and stay
 * yours. The closure is:
 *   - dvbi_v6.0-with-hls-hbbtv.xsd  (urn:dvb:metadata:servicediscovery:2024 + HLS/HbbTV), with its
 *     imports: dvbi_types_v1.0.xsd, tva_metadata_3-1_2024.xsd, tva_mpeg7.xsd, xml.xsd,
 *     hls-url-6.0.xsd, hbbtv-ext-6.0.xsd
 *   - tva_metadata_3-1_2024.xsd (+ tva_mpeg7.xsd) for the EPG check
 *   - xmlait/mis_xmlait.xsd (+ sdns_v1.4r13.xsd, sdns_v1.5r25b.xsd, tva_mpeg7_2005.xsd and their
 *     imports beside it) for the content deep-linked XML AIT, at the path from which the
 *     attachment's dvbi_xmlait_extension_v1.0.xsd imports it; without it the XML AIT is reported
 *     as not checked
 *
 * Where to get them: the authoritative copies ship with the specification itself. ETSI
 * TS 103 770 V1.2.1 (2024-09) annex B (normative), "Electronic Attachments", lists dvbi_v6.0.xsd,
 * dvbi_types_v1.0.xsd, tva_metadata_3-1.xsd and tva_mpeg7.xsd among the contents of the archive
 * ts_103770v010201p0.zip that accompanies the document, together with the classification scheme
 * files. Note that the archive ships the base dvbi_v6.0.xsd; the HLS and HbbTV extensions this
 * generator also emits need the composed variant, which third-party DVB-I tooling publishes.
 *
 * Also requires the devDependency libxmljs2 (native libxml2 binding).
 *
 * Without a local test/schemas/ directory, this script SKIPS (exit 0) rather than failing —
 * `npm test` stays green for anyone who hasn't supplied schemas. Run: npm run test:xsd
 * Exit code 0 = all valid (or skipped), 1 = a real validation failure.
 */
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error'; // quiet request logs during tests

const fs   = require('fs');
const path = require('path');
const http = require('http');

// Outside the working tree by preference (DVBI_SCHEMAS), falling back to the gitignored
// test/schemas/. The schema files are third-party and are never redistributed from here.
const SCHEMAS = process.env.DVBI_SCHEMAS
  ? path.resolve(process.env.DVBI_SCHEMAS.replace(/^~(?=$|\/)/, process.env.HOME || '~'))
  : path.join(__dirname, 'schemas');

// Two closures are usable and they name their files differently, so each schema is resolved by
// trying its known spellings in order of preference rather than by one fixed name:
//   - the electronic attachment archive that ships with the specification (authoritative), which
//     carries the base dvbi_v6.0.xsd and tva_metadata_3-1.xsd
//   - a composed variant published by third-party DVB-I tooling, which folds the HLS and HbbTV
//     extensions into the service list schema
// The base schema does not know the HLS extension, so a list carrying an HLS delivery instance
// can only be validated against the composed variant. Which files were used is printed on every
// run, because a conformance result means nothing without knowing what it was checked against.
const pick = (...names) => names.map(n => path.join(SCHEMAS, n)).find(fs.existsSync);
const DVBI_FILE = pick('dvbi_v6.0-with-hls-hbbtv.xsd', 'dvbi_v6.0+hls+hbbtv.xsd', 'dvbi_v6.0.xsd');
const TVA_FILE  = pick('tva_metadata_3-1_2024.xsd', 'tva_metadata_3-1.xsd');
const missing = !fs.existsSync(SCHEMAS) || !DVBI_FILE || !TVA_FILE;

if (missing) {
  console.log(`XSD conformance check: SKIPPED (no schema closure at ${SCHEMAS}).`);
  console.log('This is expected — schemas are not bundled with this project, and are deliberately');
  console.log('not redistributed from it. Set DVBI_SCHEMAS to a directory outside this working tree');
  console.log('holding the closure; see the header of this file for the file list and where the');
  console.log('authoritative copies come from.');
  process.exit(0);
}

let libxml;
try { libxml = require('libxmljs2'); }
catch { console.error('libxmljs2 not installed. Run: npm install'); process.exit(2); }

const { app, buildServiceList, scheduleDocument, programDocument, deepLinkedAit } = require('../server.js');

// Resolve the relative ./ imports inside the XSDs against the schemas dir.
process.chdir(SCHEMAS);
function loadXsd(file) {
  return libxml.parseXml(fs.readFileSync(path.join(SCHEMAS, file), 'utf8'), { baseUrl: path.join(SCHEMAS, file) });
}
const DVBI_XSD = loadXsd(path.basename(DVBI_FILE));
const TVA_XSD  = loadXsd(path.basename(TVA_FILE));
// The XML AIT schema of ETSI TS 102 809, in the xmlait/ directory of the closure with its imports.
const AIT_FILE = pick(path.join('xmlait', 'mis_xmlait.xsd'));
const AIT_XSD  = AIT_FILE ? loadXsd(path.relative(SCHEMAS, AIT_FILE)) : null;
console.log(`Schemas: ${SCHEMAS}`);
console.log(`  service list: ${path.basename(DVBI_FILE)}`);
console.log(`  TV-Anytime:   ${path.basename(TVA_FILE)}`);
console.log(`  XML AIT:      ${AIT_FILE ? path.relative(SCHEMAS, AIT_FILE) : '(none: XML AIT not checked)'}\n`);

// The HLS delivery signalling this generator can emit is described in TS 103 770 annex G, which is
// informative, and its schema extension is not part of the normative electronic attachment. A
// document carrying it therefore cannot be checked against the attachment's base schema: the
// xsi:type does not resolve and the element's own type is abstract. That is a limit of the closure
// in use, not a defect in the document, so it is reported as unchecked rather than counted as a
// failure or, worse, quietly passed over.
const SCHEMA_HAS_HLS = fs.readFileSync(DVBI_FILE, 'utf8').includes('vnd:apple:mpegurl');
const usesHls = xml => xml.includes('vnd.apple.mpegurl') || xml.includes('m3u8RefType');

let failures = 0;
let unchecked = 0;
function check(label, xmlStr, xsd) {
  if (xsd === DVBI_XSD && usesHls(xmlStr) && !SCHEMA_HAS_HLS) {
    unchecked++;
    console.log(`  ~ ${label}: NOT CHECKED (carries HLS delivery parameters, and ` +
                `${path.basename(DVBI_FILE)} has no HLS extension). Supply a composed schema to check it.`);
    return;
  }
  return _check(label, xmlStr, xsd);
}
function _check(label, xmlStr, xsd) {
  const doc = libxml.parseXml(xmlStr);
  let ok;
  try { ok = doc.validate(xsd); }
  catch (e) { console.log(`  ✗ ${label}: schema/parse error: ${e.message}`); failures++; return; }
  if (ok) { console.log(`  ✓ ${label}: VALID`); }
  else {
    failures++;
    console.log(`  ✗ ${label}: INVALID`);
    (doc.validationErrors || []).slice(0, 20).forEach(e => console.log(`      - ${String(e.message).trim()}`));
  }
}

// Renders a template's services through the real generator, so a template that would produce an
// invalid list fails here rather than when someone loads it. Templates are starting points people
// copy, so an invalid one propagates.
function checkTemplates(sample) {
  const dir = path.join(__dirname, '..', 'templates');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { /* none */ }
  if (!files.length) { console.log('  (no templates/ directory — skipped)'); return; }
  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const services = raw.kind === 'list'
      ? (raw.list && raw.list.services) || []
      : (raw.service ? [raw.service] : []);
    if (!services.length) { console.log(`  ✗ ${file}: contains no service`); failures++; continue; }
    const cfg = { ...sample, ...(raw.kind === 'list' ? raw.list : {}), services };
    check(file, buildServiceList('http://localhost:4000', cfg), DVBI_XSD);
  }
}

async function main() {
  console.log('DVB-I / TV-Anytime XSD conformance test\n');

  // 1) Service list — pure function with a comprehensive sample exercising every feature
  const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-config.json'), 'utf8'));
  console.log('Service list (comprehensive sample):');
  check('service-list.xml', buildServiceList('http://localhost:4000', sample), DVBI_XSD);

  // 2) The operator's own list, whatever it currently holds
  console.log('\nService list (live config.json):');
  const liveCfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  check('config.json', buildServiceList('http://localhost:4000', liveCfg), DVBI_XSD);

  // 3) A service offered on both unicast and 5G Broadcast, so the IdentifierBasedDeliveryParameters
  //    path is exercised on every run rather than only when somebody happens to configure one.
  console.log('\nService list (unicast + 5G Broadcast):');
  const hybrid = JSON.parse(JSON.stringify(sample));
  hybrid.services = [{
    id: 'hybrid-5g', uid: 'tag:5g-mag.org,2026:service:hybrid-5g', version: 1, enabled: true,
    name: 'Hybrid 5G', provider: '5G-MAG', lcn: 900, type: 'linear', genre: 'entertainment',
    parentalRating: null, logoLetters: '5G', logoBg: '#00a0d2', logoUrl: '', languages: [],
    targetRegion: '', subscriptionPackage: '', customEpgUrl: '',
    availableFrom: null, availableTo: null, linkedApp: null,
    instances: [
      { id: 'i-dash', label: 'Unicast', priority: 1, type: 'dash',
        url: 'https://example.com/manifest.mpd', drmSystems: [] },
      { id: 'i-mbms', label: '5G Broadcast', priority: 2, type: 'mbms',
        url: 'mbms://example.com/userservice/1', drmSystems: [] },
    ],
    epgPrograms: [],
  }];
  check('unicast + 5G Broadcast', buildServiceList('http://localhost:4000', hybrid), DVBI_XSD);

  // An instance saved without a priority, which the configuration API accepts: @priority is
  // optional with default 0, so the attribute is left out rather than written with no value.
  const noPriority = JSON.parse(JSON.stringify(hybrid));
  delete noPriority.services[0].instances[1].priority;
  check('instance without priority', buildServiceList('http://localhost:4000', noPriority), DVBI_XSD);

  // The comprehensive sample with its HLS instances left out, so that its regions, subscription
  // packages, audio languages, PNG logo and a region-tailored response are checked against the
  // base schema too.
  console.log('\nService list (regional, DASH and multicast only):');
  const regional = JSON.parse(JSON.stringify(sample));
  for (const s of regional.services) {
    s.instances = s.instances.filter(i => i.type !== 'hls');
    s.audioLanguages = ['en'];
  }
  regional.services[0].logoUrl = '/logos/uploaded/svc-a.png';
  check('regional', buildServiceList('http://localhost:4000', regional), DVBI_XSD);
  check('regional, ?region=GBR-ENG', buildServiceList('http://localhost:4000', regional,
    { srs: { status: 'OK', region: 'GBR-ENG' } }), DVBI_XSD);
  check('regional, ?region=unknown', buildServiceList('http://localhost:4000', regional,
    { srs: { status: 'ERROR_INVALID_REGION_ID' } }), DVBI_XSD);

  // 4) Every template offered by the Templates control
  console.log('\nService list (templates/):');
  checkTemplates(sample);

  // 5) EPG — spin up the app against the live config.json and validate the real endpoints: a
  //    timestamp request for the current 6 hour slot, both now/next forms, a programme by pid, and
  //    an unknown service.
  console.log('\nEPG (live config.json endpoints):');
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  const cfg  = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  const svc  = (cfg.services || []).find(s => (s.epgPrograms || []).length) || (cfg.services || [])[0];
  const slot = Math.floor(Date.now() / 1000 / 10800) * 10800;
  const window6h = `start=${slot}&end=${slot + 21600}`;
  if (svc) {
    const sid = encodeURIComponent(svc.uid);
    for (const [q, label] of [[window6h, 'epg-schedule.xml'], ['now_next=true', 'epg-nownext.xml'],
                              ['now_next=window', 'epg-nownext-window.xml']]) {
      check(label, await get(port, `/epg/schedule?sid=${sid}&${q}`), TVA_XSD);
    }
    const pid = ((await get(port, `/epg/schedule?sid=${sid}&now_next=true`)).match(/programId="([^"]+)"/) || [])[1];
    if (pid) check('epg-program.xml', await get(port, `/epg/program?pid=${encodeURIComponent(pid)}`), TVA_XSD);
  } else {
    console.log('  (no services in config.json — skipped)');
  }
  check('epg-schedule.xml, unknown sid', await get(port, `/epg/schedule?sid=no-such-service&${window6h}`), TVA_XSD);
  check('epg-program.xml, unknown pid', await get(port, '/epg/program?pid=crid%3A%2F%2Fnone%2Fx'), TVA_XSD);
  server.close();

  // A recognised service with no events: both tables, empty, and no Schedule (clause 6.5.4.1).
  {
    const { scheduleDocument } = require('../server.js');
    const none = JSON.parse(JSON.stringify(sample));
    none.services = none.services.slice(0, 1).map(s => ({ ...s, epgPrograms: [] }));
    check('epg-schedule.xml, service with no events',
      scheduleDocument(none, { sid: none.services[0].uid, now_next: 'true' }, Date.now(), 'http://localhost:4000').xml, TVA_XSD);
  }

  // 6) EPG for the comprehensive sample, whose programmes carry series, images, parental ratings
  //    and catch-up, rendered by the same functions the endpoints use.
  console.log('\nEPG (comprehensive sample):');
  const now = Date.now();
  const sampleSid = sample.services[0].uid;
  for (const [q, label] of [[{ start: String(slot), end: String(slot + 43200) }, 'schedule, 12 hours'],
                            [{ now_next: 'true' }, 'now_next=true'], [{ now_next: 'window' }, 'now_next=window']]) {
    check(label, scheduleDocument(sample, { sid: sampleSid, ...q }, now, 'https://localhost:4000').xml, TVA_XSD);
  }
  const winXml = scheduleDocument(sample, { sid: sampleSid, now_next: 'window' }, now, 'https://localhost:4000').xml;
  const odPid = (winXml.match(/<OnDemandProgram[^>]*>\s*<Program crid="([^"]+)"/) || [])[1];
  if (!odPid) { console.log('  ✗ no OnDemandProgram in the sample, so neither check below ran'); failures++; }
  else check('programme with catch-up', programDocument(sample, { pid: odPid }, now, 'https://localhost:4000'), TVA_XSD);

  // 7) The content deep-linked XML AIT that the sample's ProgramURL points to (TS 103 770 clause
  //    5.2.4.3), for the sample's HbbTV player and for an HTML5 one without the optional elements.
  console.log('\nXML AIT (comprehensive sample):');
  if (!AIT_XSD) {
    unchecked++;
    console.log(`  ~ deep-linked XML AIT: NOT CHECKED (no xmlait/mis_xmlait.xsd under ${SCHEMAS}).`);
  } else if (odPid) {
    check('deep-linked XML AIT, HbbTV', deepLinkedAit(sample, odPid), AIT_XSD);
    const html = JSON.parse(JSON.stringify(sample));
    Object.assign(html.catchupPlayer, { type: 'text/html', controlCode: 'PRESENT', urlBase: 'https://player.example.com/app' });
    delete html.catchupPlayer.visibility;
    delete html.catchupPlayer.serviceBound;
    check('deep-linked XML AIT, HTML5', deepLinkedAit(html, odPid), AIT_XSD);
  }

  const note = unchecked ? ` (${unchecked} not checked, see above)` : '';
  console.log(`\n==== ${failures === 0 ? 'ALL VALID' : failures + ' FAILURE(S)'}${note} ====`);
  process.exit(failures === 0 ? 0 : 1);
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b));
    }).on('error', reject);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
