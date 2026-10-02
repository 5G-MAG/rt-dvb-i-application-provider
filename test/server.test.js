process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
delete process.env.ADMIN_TOKEN;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const libxml = require('libxmljs2');
const { buildServiceList, buildSchedule, msDur, cgsidProblem, mbmsLocatorProblem } = require('../server.js');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const NS = { d: 'urn:dvb:metadata:servicediscovery:2024', tva: 'urn:tva:metadata:2024' };

// The publishing endpoints write config.json, config-history/ and public/logos/uploaded/, which
// hold the operator's own data. withServer() records all three before a test and puts them back
// afterwards, byte for byte, whatever the test did. Each call connects from its own loopback
// address, so the per-address rate limit on the mutating endpoints never carries over between tests.
const ROOT = path.join(__dirname, '..');
const STATE_DIRS = [path.join(ROOT, 'config-history'), path.join(ROOT, 'public', 'logos', 'uploaded')];
function snapshotState() {
  const read = file => ({ bytes: fs.readFileSync(file), stat: fs.statSync(file) });
  const cfgPath = path.join(ROOT, 'config.json');
  const cfg = fs.existsSync(cfgPath) ? read(cfgPath) : null;
  const dirs = STATE_DIRS.map(d => {
    fs.mkdirSync(d, { recursive: true });
    return [d, new Map(fs.readdirSync(d).map(f => [f, read(path.join(d, f))]))];
  });
  const put = (file, { bytes, stat }) => {
    if (fs.existsSync(file) && fs.readFileSync(file).equals(bytes)) return;
    fs.writeFileSync(file, bytes);
    fs.utimesSync(file, stat.atime, stat.mtime);
  };
  return () => {
    if (cfg) put(cfgPath, cfg); else fs.rmSync(cfgPath, { force: true });
    for (const [d, files] of dirs) {
      for (const f of fs.readdirSync(d)) if (!files.has(f)) fs.rmSync(path.join(d, f), { force: true });
      for (const [f, saved] of files) put(path.join(d, f), saved);
    }
  };
}

// fetch() bound to one local address. The kernel picks 127.0.0.1 as the source for any loopback
// destination, so the source has to be set explicitly for the server to see a different client.
function fetchFrom(localAddress) {
  const http = require('node:http');
  return async (url, opts = {}) => {
    let body = opts.body;
    const headers = { ...(opts.headers || {}) };
    if (body instanceof FormData) {
      const r = new Response(body);
      headers['content-type'] = r.headers.get('content-type');
      body = Buffer.from(await r.arrayBuffer());
    }
    const u = new URL(url);
    return new Promise((resolve, reject) => {
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search,
        method: opts.method || 'GET', headers, localAddress }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const h = Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v]);
          resolve(new Response(buf.length ? buf : null, { status: res.statusCode, headers: h }));
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  };
}

let _loopback = 1;
async function withServer(fn) {
  const { app } = require('../server.js');
  const restore = snapshotState();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const globalFetch = globalThis.fetch;
  globalThis.fetch = fetchFrom(`127.0.0.${++_loopback}`);
  try { return await fn(base); }
  finally { globalThis.fetch = globalFetch; server.close(); restore(); }
}

const putConfig = (base, cfg) => fetch(`${base}/api/config`, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg),
});
const getConfig = base => fetch(`${base}/api/config`).then(r => r.json());
const getList = base => fetch(`${base}/service-list.xml`).then(async r => parse(await r.text()));

test('msDur: converts milliseconds to xs:duration', () => {
  assert.equal(msDur(3600000), 'PT1H');
  assert.equal(msDur(1800000), 'PT30M');
  assert.equal(msDur(5400000), 'PT1H30M');
  assert.equal(msDur(15000), 'PT15S');
  assert.equal(msDur(0), 'PT0S');
  assert.equal(msDur(3661000), 'PT1H1M1S');
});

test('buildSchedule: produces contiguous, non-overlapping events cycling through programmes', () => {
  const progs = [{ dur: 30 }, { dur: 60 }];
  const from = Date.UTC(2026, 9, 2, 12), to = from + 10 * 3600000;
  const items = buildSchedule(progs, from, to);
  assert.ok(items.length > 2, 'should generate multiple cycles across the 10h window');
  assert.ok(items[0].startMs <= from && items[0].endMs > from, 'the first event overlaps the window start');
  assert.ok(items[items.length - 1].startMs < to);
  for (let i = 1; i < items.length; i++) {
    assert.equal(items[i].startMs, items[i - 1].endMs, `event ${i} must start exactly when ${i - 1} ends`);
    assert.equal(items[i].progIdx, (items[i - 1].progIdx + 1) % 2, 'progIdx must cycle through the programmes');
  }
  const later = buildSchedule(progs, from + 3600000, to);
  assert.ok(later.every(e => items.some(x => x.startMs === e.startMs && x.progIdx === e.progIdx)),
    'the same instant falls in the same event whichever window is asked for');
  assert.deepEqual(buildSchedule([{ dur: 0 }], from, to), [], 'no programme with a duration, no events');
});

function sampleConfig(overrides = {}) {
  return {
    version: 1, listName: 'Test List', providerName: 'Test Provider', listLang: 'en',
    targetCountry: 'GBR', epg: { id: 'epg-1', providerName: 'Test EPG' },
    services: [{
      id: 'svc-a', uid: 'tag:test,2024:service:a', version: 1, name: 'Service A', provider: 'Provider A',
      languages: [], lcn: 1, type: 'linear', genre: 'news', parentalRating: null,
      logoLetters: 'A', logoBg: '#111', logoUrl: '', targetRegion: 'GBR-ENG',
      subscriptionPackage: 'Premium', customEpgUrl: '', availableFrom: null, availableTo: null,
      enabled: true, linkedApp: null,
      instances: [{ id: 'i1', label: 'A', type: 'hls', priority: 1, url: 'https://example.com/a.m3u8',
        hasAudioDescription: false, hasHardOfHearing: false, subtitleCarriage: 3, drmSystems: [] }],
      epgPrograms: [],
      ...overrides,
    }],
  };
}

function parse(xml) { return libxml.parseXml(xml); }

test('buildServiceList: does not emit elements removed for schema conformance', () => {
  const doc = parse(buildServiceList('http://x', sampleConfig()));
  for (const tag of ['ServiceRestriction', 'TargetCountry', 'OriginalDeliverySource', 'NowNextInfoEndpoint']) {
    assert.equal(doc.find(`//*[local-name()="${tag}"]`).length, 0, `${tag} must not be emitted (not a real schema element)`);
  }
});

test('buildServiceList: SubscriptionPackage and Availability live inside ServiceInstance, not Service', () => {
  const cfg = sampleConfig();
  cfg.services[0].availableFrom = '2026-01-01T00:00:00Z';
  const doc = parse(buildServiceList('http://x', cfg));
  const svc = doc.get('//d:Service', NS);
  assert.equal(svc.find('./d:SubscriptionPackage', NS).length, 0, 'SubscriptionPackage must not be a direct Service child');
  assert.equal(svc.find('./d:Availability', NS).length, 0, 'Availability must not be a direct Service child');
  const inst = doc.get('//d:ServiceInstance', NS);
  assert.equal(inst.find('./d:SubscriptionPackage', NS).length, 1, 'SubscriptionPackage must be inside ServiceInstance');
  assert.equal(inst.find('./d:Availability', NS).length, 1, 'Availability must be inside ServiceInstance');
});

test('buildServiceList: RegionList has @version and Region has a valid @countryCodes', () => {
  const doc = parse(buildServiceList('http://x', sampleConfig()));
  const regionList = doc.get('//d:RegionList', NS);
  assert.ok(regionList.attr('version'), 'RegionList must have @version');
  const region = doc.get('//d:Region', NS);
  const cc = region.attr('countryCodes').value();
  assert.match(cc, /^[A-Z]{3}(,[A-Z]{3})*$/, 'countryCodes must match tva:ISO-3166-List pattern');
});

test('buildServiceList: ServiceGenre uses a real ContentCS:2011 term', () => {
  const doc = parse(buildServiceList('http://x', sampleConfig()));
  const genre = doc.get('//d:ServiceGenre', NS);
  assert.match(genre.attr('href').value(), /^urn:tva:metadata:cs:ContentCS:2011:/, 'must use ContentCS:2011, not the fictional :2019:X.0.0 form');
});

test('buildServiceList: ServiceType uses a real ServiceTypeCS:2019 term (linear/linear-radio/ondemand)', () => {
  for (const [type, expected] of [['linear', 'linear'], ['radio', 'linear-radio'], ['nonlinear', 'ondemand']]) {
    const cfg = sampleConfig(); cfg.services[0].type = type;
    const doc = parse(buildServiceList('http://x', cfg));
    const st = doc.get('//d:ServiceType', NS);
    assert.equal(st.attr('href').value(), `urn:dvb:metadata:cs:ServiceTypeCS:2019:${expected}`, `type=${type}`);
  }
});

test('buildServiceList: LCNTable/TargetRegion is a child element, not an attribute', () => {
  const doc = parse(buildServiceList('http://x', sampleConfig()));
  const table = doc.get('//d:LCNTable[d:TargetRegion]', NS);
  assert.ok(table, 'a per-region LCNTable with a TargetRegion child must exist');
  assert.equal(table.attr('TargetRegion'), null, 'TargetRegion must not be an attribute');
  assert.equal(table.get('./d:TargetRegion', NS).text(), 'GBR-ENG');
});

test('buildServiceList: multi-DRM emits one ContentProtection per system', () => {
  const cfg = sampleConfig();
  cfg.services[0].instances[0].drmSystems = [
    { system: 'widevine', encryptionScheme: 'cenc', licenseServerUrl: 'https://a' },
    { system: 'playready', encryptionScheme: 'cenc', licenseServerUrl: 'https://b' },
  ];
  const doc = parse(buildServiceList('http://x', cfg));
  assert.equal(doc.find('//d:ContentProtection', NS).length, 2);
});

// ContentGuideSource/@CGSID is typed xs:ID by the DVB-I schema, so a value that is not an NCName
// produces a list that fails validation while looking perfectly reasonable in the editor. This
// happened with an identifier that began with a digit.
test('cgsidProblem: accepts an NCName and rejects what xs:ID forbids', () => {
  const ok = { epg: { id: 'local-live-demo-epg' }, services: [] };
  assert.equal(cgsidProblem(ok), null);

  for (const bad of ['5g-mag-epg', 'has space', 'has:colon', '', '-leading-hyphen']) {
    const cfg = { epg: { id: bad }, services: [] };
    assert.ok(cgsidProblem(cfg), `"${bad}" should be rejected as a CGSID`);
  }
});

test('cgsidProblem: a service id becomes a CGSID only when it has a custom guide URL', () => {
  const withCustom = { epg: { id: 'epg' }, services: [{ id: '9bad', customEpgUrl: 'https://e.example/epg' }] };
  assert.ok(cgsidProblem(withCustom), 'a custom guide URL derives a CGSID from the service id');

  const withoutCustom = { epg: { id: 'epg' }, services: [{ id: '9bad', customEpgUrl: '' }] };
  assert.equal(cgsidProblem(withoutCustom), null,
    'without a custom guide URL the service id is not used as a CGSID, so xs:ID does not apply');
});

// An uploaded logo is operator-supplied and SVG is an accepted image type, so a file served from
// this origin could carry script. These headers make it inert whatever it contains. The file has to
// exist for the test to mean anything: on a 404 Express's own final handler replaces these headers
// with its own, which is fine for an error page but is not what is under test here.
test('mbmsLocatorProblem: accepts the MBMS URL forms of TS 26.347 clauses 8.2.3 and 8.2.4', () => {
  for (const u of [
    'mbms://example.com/userservice/1',
    'mbms://www.example.com/',
    'mbms://service1000.mbms.operator.com&label=http://www.example.com/videos/sample.mp4',
    'mbms://rom.3gpp.org&tmgi=901056&serviceArea=40201&frequency=68616&subCarrierSpacing=1.25&bandwidth=8',
  ]) assert.equal(mbmsLocatorProblem(u), null, u);
});

test('mbmsLocatorProblem: rejects what clause 8.2.2 does not allow', () => {
  for (const u of [
    'urn:3gpp:mbms:service:hybrid',          // not the mbms scheme
    'https://example.com/manifest.mpd',      // not the mbms scheme
    'mbms://',                               // no authority
    'mbms://example.com/a?x=1',              // a query is not part of the prefix
    'mbms://example.com&foo=1',              // mid-part pairs outside the ROM form
    'mbms://example.com&label=not a uri',    // suffix is not a URI
  ]) assert.ok(mbmsLocatorProblem(u), u);
});

test('buildServiceList: a 5G Broadcast instance is IdentifierBasedDeliveryParameters holding the mbms:// URL', () => {
  const url = 'mbms://service1000.mbms.operator.com&label=http://www.example.com/videos/sample.mp4';
  const xml = buildServiceList('http://x', sampleConfig({
    instances: [{ id: 'i1', label: '5G', type: 'mbms', priority: 1, url, drmSystems: [] }],
  }));
  const doc = parse(xml);
  const el = doc.find('//d:ServiceInstance/d:IdentifierBasedDeliveryParameters', NS);
  assert.equal(el.length, 1);
  assert.equal(el[0].text(), url);
  assert.equal(doc.find('//d:OtherDeliveryParameters', NS).length, 0, 'no extension point is used');
  assert.ok(!xml.includes('5g-mag:metadata'), 'no 5G-MAG namespace is declared');
});

test('PUT /api/config refuses an instance whose mbms locator is not an MBMS URL', async () => {
  const { app } = require('../server.js');
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  try {
    const cfg = sampleConfig({
      instances: [{ id: 'i1', label: '5G', type: 'mbms', priority: 1, url: 'urn:3gpp:mbms:service:hybrid', drmSystems: [] }],
    });
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/config`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /not an MBMS URL/);
  } finally { server.close(); }
});

test('uploaded logos are served with headers that neutralise an active SVG', async () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const { app } = require('../server.js');
  const dir = path2.join(__dirname, '..', 'public', 'logos', 'uploaded');
  const file = path2.join(dir, `__test-${process.pid}.svg`);
  fs2.mkdirSync(dir, { recursive: true });
  fs2.writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/logos/uploaded/${path2.basename(file)}`);
    assert.equal(res.status, 200, 'the file under test must actually be served');
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /default-src 'none'/, 'no resource of any kind may load');
    assert.match(csp, /sandbox/, 'no script execution, no same-origin context');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    server.close();
    fs2.rmSync(file, { force: true });
  }
});

// ── Publication and versioning (TS 103 770 V1.2.1 clauses 5.1.2, 5.1.4, 5.5.1, 5.5.2, 5.5.4, 5.6.2.1)

const listVersion = doc => Number(doc.get('/d:ServiceList', NS).attr('version').value());
const serviceVersion = (doc, uid) =>
  Number(doc.get(`//d:Service[d:UniqueIdentifier="${uid}"]`, NS).attr('version').value());

function twoServices() {
  const cfg = sampleConfig();
  cfg.services.push({ ...JSON.parse(JSON.stringify(cfg.services[0])),
    id: 'svc-b', uid: 'tag:test,2024:service:b', name: 'Service B', lcn: 2 });
  return cfg;
}

test('GET /service-list.xml is served as application/vnd.dvb.dvbisl+xml (clause 5.1.2)', () => withServer(async base => {
  const res = await fetch(`${base}/service-list.xml`);
  assert.equal(res.status, 200);
  assert.equal((res.headers.get('content-type') || '').split(';')[0].trim(), 'application/vnd.dvb.dvbisl+xml');
}));

test('PUT /api/config: list @version goes up, and a changed service goes up even if the caller did not bump it', () => withServer(async base => {
  assert.equal((await putConfig(base, twoServices())).status, 200);
  const first = await getList(base);
  const cfg = await getConfig(base);
  cfg.services[0].name = 'Service A renamed';          // changed, version left as it was
  assert.equal((await putConfig(base, cfg)).status, 200);
  const second = await getList(base);
  assert.equal(listVersion(second), listVersion(first) + 1);
  assert.equal(serviceVersion(second, 'tag:test,2024:service:a'), serviceVersion(first, 'tag:test,2024:service:a') + 1);
  assert.equal(serviceVersion(second, 'tag:test,2024:service:b'), serviceVersion(first, 'tag:test,2024:service:b'),
    'an unchanged service keeps its number');
}));

test('logo upload and removal publish under a new list @version and Service@version', () => withServer(async base => {
  assert.equal((await putConfig(base, twoServices())).status, 200);
  const v0 = await getList(base);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082', 'hex');
  const form = new FormData();
  form.append('logo', new Blob([png], { type: 'image/png' }), 'logo.png');
  assert.equal((await fetch(`${base}/api/logos/upload/svc-a`, { method: 'POST', body: form })).status, 200);
  const v1 = await getList(base);
  assert.equal(listVersion(v1), listVersion(v0) + 1, 'upload: list @version');
  assert.equal(serviceVersion(v1, 'tag:test,2024:service:a'), serviceVersion(v0, 'tag:test,2024:service:a') + 1, 'upload: Service@version');
  assert.equal(serviceVersion(v1, 'tag:test,2024:service:b'), serviceVersion(v0, 'tag:test,2024:service:b'));

  assert.equal((await fetch(`${base}/api/logos/upload/svc-a`, { method: 'DELETE' })).status, 200);
  const v2 = await getList(base);
  assert.equal(listVersion(v2), listVersion(v1) + 1, 'removal: list @version');
  assert.equal(serviceVersion(v2, 'tag:test,2024:service:a'), serviceVersion(v1, 'tag:test,2024:service:a') + 1, 'removal: Service@version');
}));

test('history restore publishes the older copy under new list, RegionList and Service @version numbers', () => withServer(async base => {
  assert.equal((await putConfig(base, twoServices())).status, 200);
  const old = await getList(base);
  const cfg = await getConfig(base);
  cfg.services[0].name = 'Service A renamed';
  assert.equal((await putConfig(base, cfg)).status, 200);
  const current = await getList(base);
  // The snapshot of the state before the last save is the newest file in the history.
  const hist = await fetch(`${base}/api/history`).then(r => r.json());
  const snap = hist.find(h => h.version === listVersion(old));
  assert.ok(snap, 'the earlier state was saved to history');
  assert.equal((await fetch(`${base}/api/history/restore/${snap.filename}`, { method: 'POST' })).status, 200);
  const restored = await getList(base);
  assert.equal(listVersion(restored), listVersion(current) + 1, 'list @version');
  assert.equal(Number(restored.get('//d:RegionList', NS).attr('version').value()),
    Number(current.get('//d:RegionList', NS).attr('version').value()) + 1, 'RegionList@version');
  assert.equal(serviceVersion(restored, 'tag:test,2024:service:a'), serviceVersion(current, 'tag:test,2024:service:a') + 1,
    'the service whose content went back changes number upwards');
  assert.equal(serviceVersion(restored, 'tag:test,2024:service:b'), serviceVersion(current, 'tag:test,2024:service:b'));
}));

test('ServiceInstance without a priority is written without @priority (schema default 0), never "undefined"', () => {
  const cfg = sampleConfig();
  delete cfg.services[0].instances[0].priority;
  const xml = buildServiceList('http://x', cfg);
  assert.ok(!xml.includes('undefined'));
  assert.equal(parse(xml).get('//d:ServiceInstance', NS).attr('priority'), null);
  cfg.services[0].instances[0].priority = 0;
  assert.equal(parse(buildServiceList('http://x', cfg)).get('//d:ServiceInstance', NS).attr('priority').value(), '0');
});

test('PUT /api/config accepts a missing priority and refuses one that is not a non-negative integer', () => withServer(async base => {
  const cfg = sampleConfig();
  delete cfg.services[0].instances[0].priority;
  assert.equal((await putConfig(base, cfg)).status, 200);
  for (const bad of ['abc', -1, 1.5]) {
    cfg.services[0].instances[0].priority = bad;
    const res = await putConfig(base, cfg);
    assert.equal(res.status, 400, String(bad));
    assert.match((await res.json()).error, /priority/);
  }
}));

test('PUT /api/config and history restore refuse two published services with one UniqueIdentifier (clause 5.1.4)', () => withServer(async base => {
  const cfg = twoServices();
  cfg.services[1].uid = cfg.services[0].uid;
  const res = await putConfig(base, cfg);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /UniqueIdentifier/);

  cfg.services[1].enabled = false;                       // not published, so not a second definition
  assert.equal((await putConfig(base, cfg)).status, 200);

  const snapName = `config-9999-test-${process.pid}.json`;
  const snap = { ...cfg, services: cfg.services.map(s => ({ ...s, enabled: true })) };
  fs.writeFileSync(path.join(ROOT, 'config-history', snapName), JSON.stringify(snap));
  const r2 = await fetch(`${base}/api/history/restore/${snapName}`, { method: 'POST' });
  assert.equal(r2.status, 400);
  assert.match((await r2.json()).error, /UniqueIdentifier/);
}));

test('editor: Clone gives the copy its own UniqueIdentifier', () => {
  const vm = require('node:vm');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const src = html.match(/function cloneService\(i\) \{[\s\S]*?\n\}/)[0];
  const ctx = { config: twoServices(), renderServices() {}, refreshXML() {}, showToast() {} };
  vm.createContext(ctx);
  vm.runInContext(`${src}; cloneService(0); cloneService(0);`, ctx);
  const uids = ctx.config.services.map(s => s.uid);
  assert.equal(uids.length, 4);
  assert.equal(new Set(uids).size, 4, uids.join(', '));
});

// ── Service list content (TS 103 770 V1.2.1 clauses 5.1.5, 5.2.6.2, 5.2.8.2.1, 5.2.10, 5.5.1, 5.5.2,
//    5.5.12, 5.6.2.1, 5.6.4)

function regionalConfig() {
  const cfg = twoServices();                              // a: GBR-ENG, b: GBR-ENG
  cfg.services[1].targetRegion = 'GBR-SCT';
  cfg.services.push({ ...JSON.parse(JSON.stringify(cfg.services[0])),
    id: 'svc-c', uid: 'tag:test,2024:service:c', name: 'Service C', lcn: 3, targetRegion: '',
    subscriptionPackage: 'Basic' });
  return cfg;
}

test('SubscriptionPackageList lists each package used on a service instance once (clause 5.1.5)', () => {
  const cfg = regionalConfig();                           // a: Premium, b: Premium, c: Basic
  const doc = parse(buildServiceList('http://x', cfg));
  const list = doc.find('/d:ServiceList/d:SubscriptionPackageList/d:SubscriptionPackage', NS).map(e => e.text());
  assert.deepEqual(list.sort(), ['Basic', 'Premium']);
  for (const s of cfg.services) s.subscriptionPackage = '';
  assert.equal(parse(buildServiceList('http://x', cfg)).find('//d:SubscriptionPackageList', NS).length, 0);
});

test('service logo is signalled only as image/jpeg or image/png (clause 5.2.6.2)', () => {
  const logoTypes = logoUrl => {
    const doc = parse(buildServiceList('http://x', sampleConfig({ logoUrl })));
    return doc.find('//d:Service/d:RelatedMaterial[tva:HowRelated/@href="urn:dvb:metadata:cs:HowRelatedCS:2021:1001.2"]/tva:MediaLocator/tva:MediaUri', NS)
      .map(e => e.attr('contentType').value());
  };
  assert.deepEqual(logoTypes('/logos/uploaded/a.png'), ['image/png']);
  assert.deepEqual(logoTypes('https://img.example.com/a.JPG'), ['image/jpeg']);
  assert.deepEqual(logoTypes('data:image/png;base64,iVBORw0KGgo='), ['image/png']);
  for (const other of ['', '/logos/uploaded/a.svg', 'https://img.example.com/a.webp',
    'https://img.example.com/a.gif', 'http://localhost:4000/logos/svc-a']) {
    assert.deepEqual(logoTypes(other), [], `"${other}" is not a JPEG or PNG logo`);
  }
});

test('logo upload accepts PNG and JPEG and refuses other image types with 400', () => withServer(async base => {
  assert.equal((await putConfig(base, sampleConfig())).status, 200);
  const upload = (name, type) => {
    const form = new FormData();
    form.append('logo', new Blob([Buffer.from('x')], { type }), name);
    return fetch(`${base}/api/logos/upload/svc-a`, { method: 'POST', body: form });
  };
  for (const [name, type] of [['a.svg', 'image/svg+xml'], ['a.webp', 'image/webp'], ['a.gif', 'image/gif']]) {
    const res = await upload(name, type);
    assert.equal(res.status, 400, name);
    assert.match((await res.json()).error, /PNG or JPEG/);
  }
  assert.equal((await upload('a.jpg', 'image/jpeg')).status, 200);
}));

test('image_variant outside table 8 is answered 400 on every endpoint (clause 5.2.8.2.1)', () => withServer(async base => {
  const cfg = sampleConfig({ epgPrograms: [{ title: 'T', dur: 60, desc: 'D', image: 'https://img.example.com/p.jpg' }] });
  assert.equal((await putConfig(base, cfg)).status, 200);
  const sid = encodeURIComponent(cfg.services[0].uid);
  for (const p of ['/service-list.xml', '/logos/svc-a', `/epg/schedule?sid=${sid}&now_next=true`, '/5gmag.png']) {
    const sep = p.includes('?') ? '&' : '?';
    for (const bad of ['16x9', 'SQUARE_COLOUR', '', 'square_colour&image_variant=4x3_colour']) {
      const res = await fetch(`${base}${p}${sep}image_variant=${bad}`);
      assert.equal(res.status, 400, `${p} image_variant=${bad}`);
    }
    assert.notEqual((await fetch(`${base}${p}${sep}image_variant=square_colour`)).status, 400, `${p} valid variant`);
  }
}));

test('a requested image variant that does not exist returns no image for the item (clause 5.2.8.2.1)', () => withServer(async base => {
  const cfg = sampleConfig({ logoUrl: '/logos/uploaded/a.png',
    epgPrograms: [{ title: 'T', dur: 60, desc: 'D', image: 'https://img.example.com/p.jpg' }] });
  assert.equal((await putConfig(base, cfg)).status, 200);
  const logos = async q => parse(await (await fetch(`${base}/service-list.xml${q}`)).text())
    .find('//d:Service/d:RelatedMaterial', NS).length;
  assert.equal(await logos(''), 1, 'the default logo without a variant');
  assert.equal(await logos('?image_variant=16x9_white'), 0);
  const sched = q => fetch(`${base}/epg/schedule?sid=${encodeURIComponent(cfg.services[0].uid)}&now_next=true${q}`)
    .then(async r => parse(await r.text()));
  assert.ok((await sched('')).find('//tva:ProgramInformation', NS).length > 0);
  assert.ok((await sched('')).find('//tva:RelatedMaterial', NS).length > 0, 'the default image without a variant');
  assert.equal((await sched('&image_variant=16x9_white')).find('//tva:RelatedMaterial', NS).length, 0);
}));

test('PUT /api/config refuses a service name language that is empty or used twice (clause 5.2.10)', () => withServer(async base => {
  for (const [languages, ok] of [
    [[{ lang: 'en', name: 'A' }, { lang: 'fr', name: 'B' }], true],
    [[{ lang: 'en', name: 'A' }, { lang: 'en', name: 'B' }], false],
    [[{ lang: 'en', name: 'A' }, { lang: '', name: 'B' }], false],
  ]) {
    const res = await putConfig(base, sampleConfig({ languages }));
    assert.equal(res.status, ok ? 200 : 400, JSON.stringify(languages));
    if (!ok) assert.match((await res.json()).error, /5\.2\.10/);
  }
}));

test('LanguageList holds the configured audio languages, not the name languages (table 14)', () => {
  const cfg = sampleConfig({ languages: [{ lang: 'de', name: 'A' }], audioLanguages: ['en', 'fr'] });
  const langs = doc => doc.find('/d:ServiceList/d:LanguageList/d:Language', NS).map(e => e.text());
  assert.deepEqual(langs(parse(buildServiceList('http://x', cfg))), ['en', 'fr']);
  delete cfg.services[0].audioLanguages;
  assert.equal(parse(buildServiceList('http://x', cfg)).find('//d:LanguageList', NS).length, 0,
    'no audio language configured, no LanguageList');
});

test('service ProviderName carries @xml:lang (table 15)', () => {
  const doc = parse(buildServiceList('http://x', sampleConfig()));
  const pn = doc.get('//d:Service/d:ProviderName', NS);
  assert.equal(pn.attr('lang').value(), 'en');
});

test('one applicable LCN table per TargetRegion: no table without TargetRegion beside regional ones (clause 5.5.12)', () => {
  const doc = parse(buildServiceList('http://x', regionalConfig()));
  const tables = doc.find('//d:LCNTable', NS);
  assert.equal(tables.length, 2);
  for (const t of tables) {
    assert.equal(t.find('./d:TargetRegion', NS).length, 1, 'every table names its region');
    assert.ok(t.find('./d:LCN', NS).some(l => l.attr('serviceRef').value() === 'tag:test,2024:service:c'),
      'the service that targets no region is numbered in every region\'s table');
  }
  const cfg = regionalConfig();
  for (const s of cfg.services) s.targetRegion = '';
  const flat = parse(buildServiceList('http://x', cfg)).find('//d:LCNTable', NS);
  assert.equal(flat.length, 1);
  assert.equal(flat[0].find('./d:TargetRegion', NS).length, 0);
});

test('Region@countryCodes is the configured country, never derived from the region id (table 38)', () => withServer(async base => {
  const cfg = sampleConfig({ targetRegion: 'EUR' });
  cfg.targetCountry = 'FRA';
  assert.equal(parse(buildServiceList('http://x', cfg)).get('//d:Region', NS).attr('countryCodes').value(), 'FRA');
  cfg.targetCountry = '';
  const xml = buildServiceList('http://x', cfg);
  assert.ok(!/countryCodes="(EUR|ZZZ)"/.test(xml), 'no code made up from the region identifier');
  const res = await putConfig(base, cfg);
  assert.equal(res.status, 400, 'regions without a country are refused on publish');
  assert.match((await res.json()).error, /countryCodes/);
}));

test('Server-side Region Selection by regionID with @responseStatus (clauses 5.6.4.4, 5.6.4.5)', () => withServer(async base => {
  assert.equal((await putConfig(base, regionalConfig())).status, 200);
  const get = async q => parse(await (await fetch(`${base}/service-list.xml${q}`)).text());
  const status = doc => doc.get('/d:ServiceList', NS).attr('responseStatus');
  const uids = doc => doc.find('//d:Service/d:UniqueIdentifier', NS).map(e => e.text()).sort();

  const plain = await get('');
  assert.equal(status(plain), null, 'no SRS query, no @responseStatus');
  assert.equal(uids(plain).length, 3);

  const tailored = await get('?region=GBR-SCT');
  assert.equal(status(tailored).value(), 'OK');
  assert.deepEqual(uids(tailored), ['tag:test,2024:service:b', 'tag:test,2024:service:c']);
  assert.deepEqual(tailored.find('//d:Region', NS).map(r => r.attr('regionID').value()), ['GBR-SCT']);
  assert.equal(tailored.find('//d:LCNTable', NS).length, 1);

  const unknown = await get('?region=FRA-IDF');
  assert.equal(status(unknown).value(), 'ERROR_INVALID_REGION_ID');
  assert.equal(uids(unknown).length, 3, 'the error response is the untailored list');

  assert.equal(status(await get('?region=')).value(), 'ERROR_INVALID_REQUEST');
  assert.equal(status(await get('?region=GBR-SCT&region=GBR-ENG')).value(), 'ERROR_INVALID_REQUEST');
}));

// ── Content guide (TS 103 770 V1.2.1 clauses 6.1, 6.5.2, 6.5.3, 6.5.4, 6.6, 6.10)

const { scheduleDocument, programDocument } = require('../server.js');
const TNS = { t: 'urn:tva:metadata:2024', xsi: 'http://www.w3.org/2001/XMLSchema-instance' };
// 12:00 UTC on a fixed day, so every window below is computed from a known "now".
const NOW = Date.UTC(2026, 9, 2, 12, 10);
const MIDNIGHT_S = Date.UTC(2026, 9, 2) / 1000;

function guideConfig() {
  return sampleConfig({ epgPrograms: [
    { title: 'Morning News', dur: 60, desc: 'Headlines', genre: 'news', parentalAge: 12, seriesTitle: 'Daily',
      seriesNumber: 1, episodeNumber: 3, image: 'https://img.example.com/news.jpg', catchupUrl: 'https://vod.example.com/news' },
    { title: 'Weather', dur: 30, desc: 'Forecast', image: 'https://img.example.com/w.webp' },
  ] });
}
const sid = 'tag:test,2024:service:a';
const sched = (q, cfg = guideConfig()) => scheduleDocument(cfg, { sid, ...q }, NOW);

test('service refers to its content guide source with ContentGuideSourceRef, and is queried by UniqueIdentifier (clause 6.1)', () => withServer(async base => {
  const cfg = guideConfig();
  cfg.services.push({ ...JSON.parse(JSON.stringify(cfg.services[0])), id: 'svc-x', uid: 'tag:test,2024:service:x',
    lcn: 9, customEpgUrl: 'https://epg.example.com/x' });
  const doc = parse(buildServiceList('http://x', cfg));
  const cgsids = doc.find('//d:ContentGuideSourceList/d:ContentGuideSource', NS).map(e => e.attr('CGSID').value());
  const refs = doc.find('//d:Service/d:ContentGuideSourceRef', NS).map(e => e.text());
  assert.deepEqual(refs, ['epg-1', 'epg-svc-x']);
  assert.ok(refs.every(r => cgsids.includes(r)), 'every reference matches a CGSID');
  assert.equal(doc.find('//d:ContentGuideServiceRef', NS).length, 0, 'no identifier the guide does not answer to');
  assert.match(doc.get('//d:ContentGuideSource[@CGSID="epg-1"]/d:ProgramInfoEndpoint/dvbisd-t:URI',
    { ...NS, 'dvbisd-t': 'urn:dvb:metadata:servicediscovery-types:2023' }).text(), /\/epg\/program$/);

  assert.equal((await putConfig(base, guideConfig())).status, 200);
  const uid = parse(await (await fetch(`${base}/service-list.xml`)).text()).get('//d:Service/d:UniqueIdentifier', NS).text();
  const res = await fetch(`${base}/epg/schedule?sid=${encodeURIComponent(uid)}&now_next=true`);
  assert.equal(res.status, 200);
  assert.ok(parse(await res.text()).find('//t:ScheduleEvent', TNS).length > 0);
}));

test('timestamp schedule request: start and end filter the events (clause 6.5.2.1)', () => {
  const start = MIDNIGHT_S + 4 * 10800, end = start + 21600;
  const { status, xml } = sched({ start: String(start), end: String(end) });
  assert.equal(status, 200);
  const doc = parse(xml);
  const starts = doc.find('//t:ScheduleEvent/t:PublishedStartTime', TNS).map(e => Date.parse(e.text()) / 1000);
  assert.ok(starts.length >= 6);
  assert.ok(starts.every(t => t >= start && t < end), 'only events starting in [start, end)');
  assert.equal(doc.get('//t:Schedule', TNS).attr('serviceIDRef').value(), sid);
  const twelve = parse(sched({ start: String(start), end: String(start + 43200) }).xml);
  assert.ok(twelve.find('//t:ScheduleEvent', TNS).length > starts.length, '12 hour span');
});

test('timestamp schedule request: 400 for a missing, invalid or out-of-range start or end (clause 6.5.2.1)', () => {
  const s = MIDNIGHT_S + 4 * 10800;
  for (const [q, why] of [
    [{}, 'neither'], [{ start: String(s) }, 'no end'], [{ end: String(s + 21600) }, 'no start'],
    [{ start: 'abc', end: String(s + 21600) }, 'not a timestamp'],
    [{ start: String(s + 3600), end: String(s + 3600 + 21600) }, 'not a multiple of 10 800'],
    [{ start: String(s), end: String(s + 10800) }, '3 hours'],
    [{ start: String(s), end: String(s + 32400) }, '9 hours'],
    [{ start: String(MIDNIGHT_S - 28 * 86400 - 10800), end: String(MIDNIGHT_S - 28 * 86400 + 10800) }, 'before -28 days'],
    [{ start: String(MIDNIGHT_S + 29 * 86400 - 10800), end: String(MIDNIGHT_S + 29 * 86400 + 10800) }, 'after +28 days'],
    [{ now_next: 'yes' }, 'now_next neither true nor window'],
  ]) assert.equal(sched(q).status, 400, why);
  assert.equal(sched({ start: String(MIDNIGHT_S - 28 * 86400), end: String(MIDNIGHT_S - 28 * 86400 + 21600) }).status, 200, 'earliest start');
  assert.equal(sched({ start: String(MIDNIGHT_S + 29 * 86400 - 21600), end: String(MIDNIGHT_S + 29 * 86400) }).status, 200, 'latest end');
});

test('unknown Service ID is answered 200 with empty ProgramInformationTable and ProgramLocationTable (clause 6.5.2.2)', () => withServer(async base => {
  for (const q of [`start=${MIDNIGHT_S}&end=${MIDNIGHT_S + 21600}`, 'now_next=true']) {
    const res = await fetch(`${base}/epg/schedule?sid=no-such-service&${q}`);
    assert.equal(res.status, 200, q);
    const doc = parse(await res.text());
    assert.equal(doc.find('//t:ProgramInformationTable', TNS).length, 1);
    assert.equal(doc.find('//t:ProgramLocationTable', TNS).length, 1);
    assert.equal(doc.find('//t:ProgramInformationTable/*|//t:ProgramLocationTable/*', TNS).length, 0);
  }
}));

test('every event in the ProgramLocationTable has its ProgramInformation, and only those (clause 6.5.4.1)', () => {
  for (const q of [{ start: String(MIDNIGHT_S + 4 * 10800), end: String(MIDNIGHT_S + 6 * 10800) }, { now_next: 'window' }]) {
    const doc = parse(sched(q).xml);
    const pis = doc.find('//t:ProgramInformation', TNS).map(e => e.attr('programId').value()).sort();
    const evs = doc.find('//t:ScheduleEvent/t:Program', TNS).map(e => e.attr('crid').value()).sort();
    assert.deepEqual(pis, evs);
    assert.equal(new Set(pis).size, pis.length, 'one ProgramInformation per event');
  }
});

test('now_next=true: the on-air event and the next one, in the now and later groups (clauses 6.5.3.1, 6.5.4.4)', () => {
  const doc = parse(sched({ now_next: 'true' }).xml);
  const member = g => doc.find(`//t:ProgramInformation/t:MemberOf[@crid="crid://dvb.org/metadata/schedules/now-next/${g}"]`, TNS);
  assert.equal(member('now').length, 1);
  assert.equal(member('now')[0].attr('index').value(), '1');
  assert.equal(member('later').length, 1);
  assert.equal(member('later')[0].attr('index').value(), '1');
  assert.equal(member('earlier').length, 0);
  const groups = doc.find('//t:GroupInformationTable/t:GroupInformation', TNS);
  assert.deepEqual(groups.map(g => [g.attr('groupId').value(), g.attr('numOfItems').value(), g.attr('ordered').value()]), [
    ['crid://dvb.org/metadata/schedules/now-next/now', '1', 'true'],
    ['crid://dvb.org/metadata/schedules/now-next/later', '1', 'true'],
  ]);
  for (const g of groups) {
    assert.equal(g.get('./t:GroupType/@xsi:type', TNS).value(), 'ProgramGroupTypeType');
    assert.equal(g.get('./t:GroupType', TNS).attr('value').value(), 'otherCollection');
  }
  const ev = doc.find('//t:ScheduleEvent/t:PublishedStartTime', TNS).map(e => Date.parse(e.text()));
  assert.ok(ev[0] <= NOW, 'the first event is on air');
});

test('now_next=window: up to ten earlier and ten later events, ordered by @index (clause 6.5.4.4)', () => {
  const doc = parse(sched({ now_next: 'window' }).xml);
  const byGroup = g => doc.find(`//t:ProgramInformation[t:MemberOf/@crid="crid://dvb.org/metadata/schedules/now-next/${g}"]`, TNS)
    .map(pi => ({ crid: pi.attr('programId').value(),
      index: Number(pi.get(`./t:MemberOf[@crid="crid://dvb.org/metadata/schedules/now-next/${g}"]`, TNS).attr('index').value()) }));
  const startOf = crid => Date.parse(doc.get(`//t:ScheduleEvent[t:Program/@crid="${crid}"]/t:PublishedStartTime`, TNS).text());
  const earlier = byGroup('earlier'), later = byGroup('later'), now = byGroup('now');
  assert.equal(now.length, 1);
  assert.equal(earlier.length, 10);
  assert.equal(later.length, 10);
  for (const [list, dir] of [[earlier, -1], [later, 1]]) {
    const sorted = list.slice().sort((a, b) => a.index - b.index);
    assert.deepEqual(sorted.map(x => x.index), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(dir * (startOf(sorted[i].crid) - startOf(sorted[i - 1].crid)) > 0, 'index 1 is next to the on-air event');
    }
    assert.ok(dir * (startOf(sorted[0].crid) - startOf(now[0].crid)) > 0);
  }
});

test('programme information by pid: one ProgramInformation, 200 with empty tables for an unknown CRID (clauses 6.6.2, 6.6.3)', () => withServer(async base => {
  assert.equal((await putConfig(base, guideConfig())).status, 200);
  const nn = parse(await (await fetch(`${base}/epg/schedule?sid=${encodeURIComponent(sid)}&now_next=window`)).text());
  const withCatchup = nn.get('//t:OnDemandProgram/t:Program', TNS).attr('crid').value();
  const res = await fetch(`${base}/epg/program?pid=${encodeURIComponent(withCatchup)}`);
  assert.equal(res.status, 200);
  const doc = parse(await res.text());
  assert.deepEqual(doc.find('//t:ProgramInformation', TNS).map(e => e.attr('programId').value()), [withCatchup]);
  const fromSchedule = nn.get(`//t:ProgramInformation[@programId="${withCatchup}"]/t:BasicDescription`, TNS).toString();
  assert.equal(doc.get('//t:ProgramInformation/t:BasicDescription', TNS).toString(), fromSchedule,
    'all programme data provided in the Schedules response');
  assert.equal(doc.find('//t:ProgramLocationTable/t:OnDemandProgram', TNS).length, 1);

  const noCatchup = nn.get('//t:ProgramInformation[not(t:BasicDescription/t:Genre)]', TNS).attr('programId').value();
  const plain = parse(await (await fetch(`${base}/epg/program?pid=${encodeURIComponent(noCatchup)}`)).text());
  assert.equal(plain.find('//t:ProgramLocationTable', TNS).length, 1, 'the table is present');
  assert.equal(plain.find('//t:ProgramLocationTable/*', TNS).length, 0, 'and empty when not on demand');

  for (const pid of ['crid://dvbi.example.com/2024/prog/svc-a/1', 'crid://elsewhere/x', '']) {
    const r = await fetch(`${base}/epg/program?pid=${encodeURIComponent(pid)}`);
    assert.equal(r.status, 200, pid);
    const d = parse(await r.text());
    assert.equal(d.find('//t:ProgramInformationTable', TNS).length + d.find('//t:ProgramLocationTable', TNS).length, 2);
    assert.equal(d.find('//t:ProgramInformationTable/*|//t:ProgramLocationTable/*', TNS).length, 0, pid);
  }
  assert.equal((await fetch(`${base}/epg/program`)).status, 200, 'no pid at all');
}));

test('metadata profile of guide responses (clause 6.10: tables 41, 42, 52, 59, 62)', () => {
  const doc = parse(sched({ now_next: 'window' }).xml);
  for (const s of doc.find('//t:Synopsis', TNS)) assert.equal(s.attr('length').value(), 'medium');
  for (const m of doc.find('//t:ProgramInformation/t:MemberOf', TNS)) {
    assert.equal(m.get('./@xsi:type', TNS).value(), 'MemberOfType');
  }
  const imgs = doc.find('//t:BasicDescription/t:RelatedMaterial/t:MediaLocator/t:MediaUri', TNS);
  assert.ok(imgs.length > 0);
  for (const u of imgs) {
    assert.equal(u.attr('contentType').value(), 'image/jpeg');
    assert.ok(!u.text().endsWith('.webp'), 'a WebP-only image is not signalled');
  }
  const ods = doc.find('//t:OnDemandProgram', TNS);
  assert.ok(ods.length > 0);
  for (const od of ods) {
    assert.equal(od.attr('serviceIDRef').value(), sid);
    const genres = od.find('./t:InstanceDescription/t:Genre', TNS).map(g => g.attr('href').value());
    assert.equal(genres.length, 2);
    assert.match(genres[0], /^urn:fvc:metadata:cs:MediaAvailabilityCS:2014-07:media_(un)?available$/);
    assert.equal(genres[1], 'urn:fvc:metadata:cs:FEPGAvailabilityCS:2014-10:fepg_unavailable');
  }
  const startOf = od => Date.parse(od.get('./t:StartOfAvailability', TNS).text());
  const endOf = od => Date.parse(od.get('./t:EndOfAvailability', TNS).text());
  for (const od of ods) {
    const want = NOW >= startOf(od) && NOW < endOf(od) ? 'media_available' : 'media_unavailable';
    assert.ok(od.get('./t:InstanceDescription/t:Genre', TNS).attr('href').value().endsWith(want));
  }
});

test('PUT /api/config refuses a programme title over 80 or a description over 250 characters (table 42)', () => withServer(async base => {
  const cfg = guideConfig();
  cfg.services[0].epgPrograms[0].title = 'é'.repeat(80);
  cfg.services[0].epgPrograms[0].desc = 'é'.repeat(250);
  assert.equal((await putConfig(base, cfg)).status, 200, 'at the limits, counted in characters');
  cfg.services[0].epgPrograms[0].title = 'x'.repeat(81);
  let res = await putConfig(base, cfg);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /80 characters/);
  cfg.services[0].epgPrograms[0].title = 'ok';
  cfg.services[0].epgPrograms[0].desc = 'x'.repeat(251);
  res = await putConfig(base, cfg);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /250 characters/);
}));

// ── HTTP over TLS (TS 103 770 V1.2.1 clause 7.3)
// These start the real server through startServer(), which sets the scheme written into the list
// for the rest of the process, so they come last in this file.

const { startServer } = require('../server.js');
const listening = srv => new Promise((resolve, reject) => { srv.once('listening', resolve); srv.once('error', reject); });

function selfSigned() {
  const { execFileSync } = require('node:child_process');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvbi-tls-'));
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  return { dir, key, cert };
}

const haveOpenssl = (() => {
  try { require('node:child_process').execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
})();

test('startServer refuses to start without a certificate unless PLAIN_HTTP names the case (clause 7.3)', () => {
  assert.throws(() => startServer({}, 0), /HTTPS_KEY_PATH and HTTPS_CERT_PATH are required/);
  assert.throws(() => startServer({ HTTPS_KEY_PATH: '/nonexistent/key.pem', HTTPS_CERT_PATH: '/nonexistent/cert.pem' }, 0),
    /ENOENT/, 'an unreadable certificate is an error, not a fall back to HTTP');
  assert.throws(() => startServer({ PLAIN_HTTP: 'yes' }, 0), /PLAIN_HTTP must be one of/);
});

test('HTTPS by default: TLS 1.2 and TLS 1.3 accepted, https:// endpoints in the list (clause 7.3)',
  { skip: haveOpenssl ? false : 'openssl not available to make a test certificate' }, async () => {
  const tls = require('node:tls');
  const { dir, key, cert } = selfSigned();
  const restore = snapshotState();
  const srv = startServer({ HTTPS_KEY_PATH: key, HTTPS_CERT_PATH: cert }, 0);
  try {
    await listening(srv);
    const port = srv.address().port;
    for (const v of ['TLSv1.2', 'TLSv1.3']) {
      const got = await new Promise((resolve, reject) => {
        const sock = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, minVersion: v, maxVersion: v },
          () => { resolve(sock.getProtocol()); sock.end(); });
        sock.on('error', reject);
      });
      assert.equal(got, v);
    }
    const xml = await new Promise((resolve, reject) => {
      require('node:https').get({ host: '127.0.0.1', port, path: '/service-list.xml', rejectUnauthorized: false,
        headers: { host: 'dvbi.example.org' } }, res => {
        let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b));
      }).on('error', reject);
    });
    const uris = parse(xml).find('//d:ContentGuideSource//dvbisd-t:URI',
      { ...NS, 'dvbisd-t': 'urn:dvb:metadata:servicediscovery-types:2023' }).map(e => e.text());
    assert.ok(uris.length && uris.every(u => u.startsWith('https://dvbi.example.org/')), uris.join(' '));
  } finally {
    srv.close();
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PLAIN_HTTP=behind-tls-proxy serves HTTP but writes https:// endpoints; private-subnet writes http://', async () => {
  for (const [mode, scheme] of [['behind-tls-proxy', 'https'], ['private-subnet', 'http']]) {
    const restore = snapshotState();
    const srv = startServer({ PLAIN_HTTP: mode }, 0);
    try {
      await listening(srv);
      const res = await fetchFrom('127.0.0.250')(`http://127.0.0.1:${srv.address().port}/service-list.xml`);
      assert.equal(res.status, 200);
      const uris = parse(await res.text()).find('//d:ContentGuideSource//dvbisd-t:URI',
        { ...NS, 'dvbisd-t': 'urn:dvb:metadata:servicediscovery-types:2023' }).map(e => e.text());
      assert.ok(uris.length && uris.every(u => u.startsWith(`${scheme}://127.0.0.1:`)), `${mode}: ${uris.join(' ')}`);
    } finally { srv.close(); restore(); }
  }
});
