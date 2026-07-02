process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const libxml = require('libxmljs2');
const { buildServiceList, buildSchedule, msDur } = require('../server.js');

const NS = { d: 'urn:dvb:metadata:servicediscovery:2024', tva: 'urn:tva:metadata:2024' };

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
