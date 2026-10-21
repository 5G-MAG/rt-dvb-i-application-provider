// Tests for the spec-compliance and validation fixes. Runs against a throwaway data directory so
// the write paths (publish, history, restore) never touch the real config.json or config-history/.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dvbi-fixes-'));
process.env.DVBI_DATA_DIR = DATA;
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
delete process.env.ADMIN_TOKEN;

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const example = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ ...example, version: 5 }));
fs.mkdirSync(path.join(DATA, 'config-history'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'config-history', 'config-2026-01-01T00-00-00-000Z.json'),
  JSON.stringify({ ...example, version: 3, listName: 'An earlier list' }));

const { app, buildServiceList } = require('../server.js');
const rules = require('../public/validation-rules.js');
after(() => fs.rmSync(DATA, { recursive: true, force: true }));

async function withServer(fn) {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const listVersion = xml => Number(xml.match(/<ServiceList[^>]*\sversion="(\d+)"/)[1]);
const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });

// 1. TS 103 770 V1.2.1 clause 5.5.1, table 14: @version "shall be incremented for every published change".
test('restoring an earlier list, then publishing, never reuses a published @version', () => withServer(async base => {
  const seen = [];
  const served = async () => listVersion(await (await fetch(`${base}/service-list.xml`)).text());
  seen.push(await served());                                   // 5
  const hist = await (await fetch(`${base}/api/history`)).json();
  const old = hist.find(h => h.version === 3);
  assert.ok(old, 'the seeded v3 snapshot is listed');
  const r = await fetch(`${base}/api/history/restore/${old.filename}`, json('POST'));
  assert.equal((await r.json()).ok, true);
  const afterRestore = await served();
  assert.ok(afterRestore > seen[0], `restore must publish a higher version than ${seen[0]}, got ${afterRestore}`);
  seen.push(afterRestore);
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.listName, 'An earlier list', 'the restored content is what is served');
  cfg.listName = 'Edited after restore';
  await fetch(`${base}/api/config`, json('PUT', cfg));
  seen.push(await served());
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), 'versions only go up');
  assert.equal(new Set(seen).size, seen.length, `every published change has its own version: ${seen}`);
}));

// 2. TS 103 770 V1.2.1 clause 5.1.2.
test('/service-list.xml is served as application/vnd.dvb.dvbisl+xml, conditional GET intact', () => withServer(async base => {
  const res = await fetch(`${base}/service-list.xml`);
  assert.match(res.headers.get('content-type'), /^application\/vnd\.dvb\.dvbisl\+xml/);
  const lm = res.headers.get('last-modified');
  assert.ok(lm);
  const again = await fetch(`${base}/service-list.xml`, { headers: { 'If-Modified-Since': lm } });
  assert.equal(again.status, 304);
}));

// 3. Fresh install: config.example.json is what a new checkout starts from.
test('the stock list validates 11 of 11 and carries a name and id for the registry to match', () => {
  const checks = rules.listChecks(example);
  assert.equal(checks.length, 11);
  assert.deepEqual(checks.filter(c => !c.ok).map(c => c.label), []);
  assert.ok(example.listName && /^tag:/.test(example.listId));
  const xml = buildServiceList('http://x', example);
  assert.match(xml, new RegExp(`<ServiceList[^>]*\\sid="${example.listId}"`));
  assert.match(xml, new RegExp(`<Name[^>]*>${example.listName}</Name>`));
});

// 4. TS 103 770 V1.2.1 clause 5.5.15: Period/@validFrom and @validTo are both optional.
test('the service template carries no hard-coded availability period', () => {
  const t = JSON.parse(fs.readFileSync(path.join(root, 'templates', 'service-template.json'), 'utf8'));
  assert.equal(t.service.availableFrom, null);
  assert.equal(t.service.availableTo, null);
  const cfg = { ...example, services: [t.service] };
  assert.doesNotMatch(buildServiceList('http://x', cfg), /<Availability>|validFrom|validTo/);
});

// 5.
test('Validate accepts mbms:// only on the 5G extension instance', () => {
  const ok = { type: 'mbms', url: 'mbms://broadcast.example.com/x' };
  assert.equal(rules.streamUrlOk(ok), true);
  assert.equal(rules.streamUrlOk({ type: 'dash', url: 'mbms://broadcast.example.com/x' }), false);
  assert.equal(rules.streamUrlOk({ type: 'mbms', url: 'rtsp://example.com/x' }), false);
  assert.equal(rules.streamUrlOk({ type: 'hls', url: 'ftp://example.com/x' }), false);
  assert.equal(rules.streamUrlOk({ type: 'dash', url: 'https://example.com/x.mpd' }), true);
  assert.equal(rules.streamUrlOk({ type: 'multicast', url: 'udp://239.0.0.1:5004' }), true);

  const cfg = JSON.parse(JSON.stringify(example));
  cfg.services[0].instances.push({ id: 'm', type: 'mbms', label: 'M', priority: 3, url: ok.url, drmSystems: [] });
  assert.deepEqual(rules.listChecks(cfg).filter(c => !c.ok).map(c => c.label), []);
  cfg.services[0].instances.push({ id: 'd', type: 'dash', label: 'D', priority: 4, url: 'mbms://x/y', drmSystems: [] });
  assert.deepEqual(rules.listChecks(cfg).filter(c => !c.ok).map(c => c.label), ['All stream URLs use http(s)']);
});

// 6. Consistent with test/xsd-validate.js, which marks the same documents NOT CONFORMANT GROUND.
test('Compliance can tell that a list carries the local extension', () => {
  const cfg = JSON.parse(JSON.stringify(example));
  assert.equal(rules.usesLocalExtension(buildServiceList('http://x', cfg)), false);
  cfg.services[0].instances.push({ id: 'm', type: 'mbms', label: 'M', priority: 3, url: 'mbms://b.example/x', drmSystems: [] });
  assert.equal(rules.usesLocalExtension(buildServiceList('http://x', cfg)), true);
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.match(html, /DvbiRules\.usesLocalExtension\(xmlText\)/, 'checkCompliance reports the extension');
});

// 7. TS 103 770 V1.2.1 clause 5.5.2, table 15: Service@version "shall be incremented for every published change".
test('a restore or save never gives a service a version already published for it', () => withServer(async base => {
  const svcVersions = async () => {
    const xml = await (await fetch(`${base}/service-list.xml`)).text();
    return [...xml.matchAll(/<Service version="(\d+)">\s*<UniqueIdentifier>([^<]+)</g)].map(m => [m[2], Number(m[1])]);
  };
  const edit = async name => {
    const cfg = await (await fetch(`${base}/api/config`)).json();
    cfg.services[0].name = name;
    await fetch(`${base}/api/config`, json('PUT', cfg));
    return cfg.services[0].uid;
  };
  const uid = await edit('Version test A');
  const vA = (await svcVersions()).find(x => x[0] === uid)[1];
  await edit('Version test B');
  const vB = (await svcVersions()).find(x => x[0] === uid)[1];
  assert.ok(vB > vA, 'an edit raises the service version');
  // The snapshot taken when B was published holds A; restoring it puts A's content (and its old
  // version number) back, which must not be served under a number already used.
  const hist = await (await fetch(`${base}/api/history`)).json();
  const snapA = hist.find(h => { try {
    return JSON.parse(fs.readFileSync(path.join(DATA, 'config-history', h.filename), 'utf8')).services[0].name === 'Version test A';
  } catch { return false; } });
  assert.ok(snapA, 'a snapshot holding A exists');
  await fetch(`${base}/api/history/restore/${snapA.filename}`, json('POST'));
  const vR = (await svcVersions()).find(x => x[0] === uid)[1];
  assert.ok(vR > vB, `restored service must be above ${vB}, got ${vR}`);
  await edit('Version test C');
  const vC = (await svcVersions()).find(x => x[0] === uid)[1];
  assert.ok(vC > vR);
  // Saving without changing the service does not burn a version number.
  const cfg = await (await fetch(`${base}/api/config`)).json();
  await fetch(`${base}/api/config`, json('PUT', cfg));
  assert.equal((await svcVersions()).find(x => x[0] === uid)[1], vC);
}));

// 8. Clause 5.2.2: the Service List ID is a URI of a registered scheme.
test('Validate requires the Service List ID to be a URI', () => {
  assert.equal(rules.listIdProblem('tag:example.com,2026:servicelist:1'), '');
  assert.equal(rules.listIdProblem('urn:example:servicelist:1'), '');
  assert.equal(rules.listIdProblem('https://example.com/lists/1'), '');
  assert.match(rules.listIdProblem('demo'), /not an absolute URI/);
  assert.match(rules.listIdProblem('has space:x'), /not an absolute URI/);
  assert.match(rules.listIdProblem('tag:example.com:nodate'), /tag: URI/);
  assert.ok(rules.listIdProblem(''));
  const cfg = JSON.parse(JSON.stringify(example));
  cfg.listId = 'demo';
  const failed = rules.listChecks(cfg).filter(c => !c.ok);
  assert.equal(rules.listChecks(cfg).length, 11);
  assert.equal(failed.length, 1);
  assert.match(failed[0].detail, /not an absolute URI/);
});
