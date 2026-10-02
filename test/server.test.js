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
  const items = buildSchedule(progs);
  assert.ok(items.length > 2, 'should generate multiple cycles across the 10h window');
  for (let i = 1; i < items.length; i++) {
    assert.equal(items[i].startMs, items[i - 1].endMs, `event ${i} must start exactly when ${i - 1} ends`);
  }
  assert.equal(items[0].progIdx, 0);
  assert.equal(items[1].progIdx, 1);
  assert.equal(items[2].progIdx, 0, 'progIdx must cycle back to the first programme');
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
