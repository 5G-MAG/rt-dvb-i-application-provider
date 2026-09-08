#!/usr/bin/env node
/**
 * Classification scheme membership check (optional, bring-your-own scheme files).
 *
 * XSD validation cannot do this job: every CS reference is carried in an @href typed anyURI, so a
 * schema-valid document can still name a term that does not exist in the scheme it cites. That is
 * not a hypothetical here. Three such terms were wrong in this generator and were corrected by
 * hand against the registries (see COMPLIANCE.md): a ServiceTypeCS term that is not in the scheme,
 * ContentCS termIDs in a form the scheme does not use, and a SubtitlePurposeCS term from a year
 * that does not exist. Nothing re-checks that by itself, which is what this script is for.
 *
 * The DVB scheme files ship with the specification: ETSI TS 103 770 V1.2.1 (2024-09) annex B lists
 * DVBServiceTypeCS-2019.xml, DVBHowRelatedCS-2021.xml, DVBLinkedApplicationCS-2019.xml and the
 * others among the contents of ts_103770v010201p0.zip. Point DVBI_SCHEMAS at a directory holding
 * them, outside this working tree, exactly as for the XSD check:
 *
 *   DVBI_SCHEMAS=~/.local/share/dvb-i-schemas/etsi npm run test:cs
 *
 * TV-Anytime's own schemes (ContentCS, SubtitleCarriageCS, SubtitleCodingFormatCS,
 * SubtitlePurposeCS, and TVA's HowRelatedCS) are published with ETSI TS 102 822-3-1, not in that
 * archive. Terms citing a scheme whose file is absent are reported as unchecked, never as valid:
 * an unchecked term is exactly the kind that was wrong before.
 *
 * Exit code 0 = every checkable term exists (or skipped), 1 = a term is not in its scheme.
 */
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const fs   = require('fs');
const path = require('path');
const http = require('http');

const SCHEMAS = process.env.DVBI_SCHEMAS
  ? path.resolve(process.env.DVBI_SCHEMAS.replace(/^~(?=$|\/)/, process.env.HOME || '~'))
  : path.join(__dirname, 'schemas');

function loadSchemes(dir) {
  const schemes = new Map();
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.xml')); } catch { return schemes; }
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const uri = (text.match(/<ClassificationScheme[^>]*\suri="([^"]+)"/) || [])[1];
    if (!uri) continue;
    // Nested Terms already carry their fully qualified termID (3, then 3.0 inside it), so every
    // termID attribute in the file is a usable term on its own.
    const terms = new Set([...text.matchAll(/\btermID="([^"]+)"/g)].map(m => m[1]));
    schemes.set(uri, { file, terms });
  }
  return schemes;
}

const schemes = loadSchemes(SCHEMAS);
if (!schemes.size) {
  console.log(`CS membership check: SKIPPED (no classification scheme files at ${SCHEMAS}).`);
  console.log('This is expected — scheme files are not bundled with this project, and are');
  console.log('deliberately not redistributed from it. See the header of this file.');
  process.exit(0);
}

const { app, buildServiceList } = require('../server.js');

// Every CS reference this generator emits is an href of the form <scheme uri>:<termID>. Term ids
// never contain a colon, so the split is unambiguous.
function hrefs(xml) {
  return [...xml.matchAll(/href="(urn:[^"]*:cs:[^"]+)"/g)].map(m => m[1]);
}

let bad = 0, checked = 0;
const unchecked = new Map();

function checkDoc(label, xml) {
  const found = hrefs(xml);
  if (!found.length) { console.log(`  - ${label}: no CS references`); return; }
  const problems = [];
  let ok = 0;
  for (const href of new Set(found)) {
    const cut = href.lastIndexOf(':');
    const uri = href.slice(0, cut), term = href.slice(cut + 1);
    const scheme = schemes.get(uri);
    if (!scheme) {
      unchecked.set(uri, (unchecked.get(uri) || 0) + 1);
      continue;
    }
    checked++;
    if (scheme.terms.has(term)) ok++;
    else problems.push(`${href}\n        "${term}" is not a term in ${scheme.file}`);
  }
  if (problems.length) {
    bad += problems.length;
    console.log(`  x ${label}: ${problems.length} term(s) not in their scheme`);
    problems.forEach(p => console.log(`      - ${p}`));
  } else if (ok) {
    console.log(`  + ${label}: ${ok} term(s) checked, all present`);
  } else {
    console.log(`  - ${label}: ${found.length} reference(s), none from a scheme held here`);
  }
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b));
    }).on('error', reject);
  });
}

async function main() {
  console.log('DVB / TV-Anytime classification scheme membership check\n');
  console.log(`Schemes: ${SCHEMAS}`);
  for (const [uri, s] of schemes) console.log(`  ${s.file}  ->  ${uri} (${s.terms.size} terms)`);
  console.log('');

  const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-config.json'), 'utf8'));
  checkDoc('sample service list', buildServiceList('http://localhost:4000', sample));

  const live = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  checkDoc('live config.json', buildServiceList('http://localhost:4000', live));

  const dir = path.join(__dirname, '..', 'templates');
  let templates = [];
  try { templates = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { /* none */ }
  for (const file of templates) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const services = raw.kind === 'list'
      ? (raw.list && raw.list.services) || []
      : (raw.service ? [raw.service] : []);
    if (services.length) {
      checkDoc(`templates/${file}`, buildServiceList('http://localhost:4000',
        { ...sample, ...(raw.kind === 'list' ? raw.list : {}), services }));
    }
  }

  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  const svc = (live.services || []).find(s => (s.epgPrograms || []).length);
  if (svc) {
    for (const ep of ['schedule', 'nownext']) {
      checkDoc(`epg/${ep}`, await get(port, `/epg/${ep}?sid=${encodeURIComponent(svc.uid)}`));
    }
  }
  server.close();

  if (unchecked.size) {
    console.log('\n  Not checked, no scheme file for:');
    for (const [uri, n] of [...unchecked].sort()) console.log(`    ${uri}  (${n} reference(s))`);
    console.log('    TV-Anytime schemes are published with ETSI TS 102 822-3-1, not with TS 103 770.');
  }

  console.log(`\n==== ${bad === 0 ? `ALL ${checked} CHECKED TERM(S) VALID` : bad + ' INVALID TERM(S)'}` +
              `${unchecked.size ? `, ${[...unchecked.values()].reduce((a, b) => a + b, 0)} unchecked` : ''} ====`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
