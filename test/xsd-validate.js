#!/usr/bin/env node
/**
 * XSD conformance check for the DVB-I admin generator (optional, bring-your-own schemas).
 *
 * This project does NOT bundle or redistribute the ETSI/DVB XSD schema files (avoids any
 * question of redistribution rights for third-party schema files). To run real XSD validation
 * locally, place the schema closure yourself into test/schemas/ (not committed — see .gitignore):
 *   - dvbi_v6.0-with-hls-hbbtv.xsd  (urn:dvb:metadata:servicediscovery:2024 + HLS/HbbTV), with its
 *     imports: dvbi_types_v1.0.xsd, tva_metadata_3-1_2024.xsd, tva_mpeg7.xsd, xml.xsd,
 *     hls-url-6.0.xsd, hbbtv-ext-6.0.xsd
 *   - tva_metadata_3-1_2024.xsd (+ tva_mpeg7.xsd) for the EPG check
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

const SCHEMAS = path.join(__dirname, 'schemas');
const REQUIRED = ['dvbi_v6.0-with-hls-hbbtv.xsd', 'tva_metadata_3-1_2024.xsd'];
const missing = !fs.existsSync(SCHEMAS) || REQUIRED.some(f => !fs.existsSync(path.join(SCHEMAS, f)));

if (missing) {
  console.log('XSD conformance check: SKIPPED (no local test/schemas/ directory found).');
  console.log('This is expected — schemas are not bundled with this project. See the header of');
  console.log('this file for what to place in test/schemas/ if you want to run real XSD validation.');
  process.exit(0);
}

let libxml;
try { libxml = require('libxmljs2'); }
catch { console.error('libxmljs2 not installed. Run: npm install'); process.exit(2); }

const { app, buildServiceList } = require('../server.js');

// Resolve the relative ./ imports inside the XSDs against the schemas dir.
process.chdir(SCHEMAS);
function loadXsd(file) {
  return libxml.parseXml(fs.readFileSync(path.join(SCHEMAS, file), 'utf8'), { baseUrl: path.join(SCHEMAS, file) });
}
const DVBI_XSD = loadXsd('dvbi_v6.0-with-hls-hbbtv.xsd');
const TVA_XSD  = loadXsd('tva_metadata_3-1_2024.xsd');

let failures = 0;
function check(label, xmlStr, xsd) {
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

  // 3) Every template offered by the Templates control
  console.log('\nService list (templates/):');
  checkTemplates(sample);

  // 4) EPG — spin up the app against the live config.json and validate the real endpoints
  console.log('\nEPG (live config.json endpoints):');
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  const cfg  = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  const svc  = (cfg.services || []).find(s => (s.epgPrograms || []).length) || (cfg.services || [])[0];
  if (svc) {
    for (const [ep, label] of [['schedule', 'epg-schedule.xml'], ['nownext', 'epg-nownext.xml']]) {
      const xml = await get(port, `/epg/${ep}?sid=${encodeURIComponent(svc.uid)}`);
      check(label, xml, TVA_XSD);
    }
  } else {
    console.log('  (no services in config.json — skipped)');
  }
  server.close();

  console.log(`\n==== ${failures === 0 ? 'ALL VALID' : failures + ' FAILURE(S)'} ====`);
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
