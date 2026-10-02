const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const dns     = require('dns').promises;
const net     = require('net');
const crypto  = require('crypto');
const http    = require('http');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 4000;

// ── Structured logging ───────────────────────────────────────────────────────
// Minimal JSON-lines logger (no dependency): one object per line with time/level/msg/meta,
// suitable for ingestion by any log collector. LOG_LEVEL defaults to 'info'.
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL  = LOG_LEVELS[process.env.LOG_LEVEL] !== undefined ? process.env.LOG_LEVEL : 'info';
function _log(level, msg, meta) {
  if (LOG_LEVELS[level] > LOG_LEVELS[LOG_LEVEL]) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...(meta || {}) });
  (level === 'error' ? console.error : console.log)(line);
}
const logger = {
  error: (msg, meta) => _log('error', msg, meta),
  warn:  (msg, meta) => _log('warn', msg, meta),
  info:  (msg, meta) => _log('info', msg, meta),
  debug: (msg, meta) => _log('debug', msg, meta),
};

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG_PATH  = path.join(__dirname, 'config.json');
// The service list is operator data that this server rewrites on every publish, so config.json is
// not tracked. A fresh checkout has only the example, which is copied into place on first start:
// without it the server would have nothing to load and would exit before the operator could use
// the editor to create one.
const CONFIG_EXAMPLE = path.join(__dirname, 'config.example.json');
const LOGOS_DIR    = path.join(__dirname, 'public', 'logos', 'uploaded');
const HISTORY_DIR  = path.join(__dirname, 'config-history');
const TEMPLATES_DIR = path.join(__dirname, 'templates');

fs.mkdirSync(LOGOS_DIR,   { recursive: true });
fs.mkdirSync(HISTORY_DIR, { recursive: true });

// Minimal shape check so a malformed write (or a corrupted/hand-edited file) fails loudly
// at load time rather than producing confusing errors deep in the XML generator.
// ContentGuideSource/@CGSID is typed xs:ID by the DVB-I schema (ContentGuideProviderIdType, a
// restriction of ID), so it must be an NCName: no leading digit, no colon, no space. A value that
// is not produces a service list that fails schema validation while looking perfectly reasonable
// in the editor, and the ContentGuideServiceRef values pointing at it inherit the problem.
//
// Rejected on write rather than rewritten: silently correcting an operator's identifier would
// break every reference to it, and the operator is the one who knows what it should be.
const NCNAME = /^[A-Za-z_][A-Za-z0-9_.\-]*$/;

function cgsidProblem(cfg) {
  const ids = [];
  if (cfg.epg && cfg.epg.id != null) ids.push(['epg.id', String(cfg.epg.id)]);
  for (const [i, s] of (cfg.services || []).entries()) {
    // A service with a custom guide URL gets its own ContentGuideSource, whose CGSID is derived
    // from the service id, so that id has to satisfy the same rule.
    if (s && s.customEpgUrl && s.id != null) ids.push([`services[${i}].id`, String(s.id)]);
  }
  for (const [where, value] of ids) {
    if (!NCNAME.test(value)) {
      return `${where} "${value}" cannot be used as a ContentGuideSource identifier: it is typed ` +
             `xs:ID by the DVB-I schema, so it must start with a letter or underscore and contain ` +
             `only letters, digits, "_", "." or "-".`;
    }
  }
  return null;
}

// A service instance delivered over MBMS (5G Broadcast) is signalled with
// IdentifierBasedDeliveryParameters, whose value is the mbms:// locator TS 103 770 V1.2.1 clause
// 9.3.3 hands to the MBMS Client. Clause 5.5.4, table 16, defines that element as "An identifier in
// the form of a locator (URL) or name (URN) that contains the parameters of the relevant delivery
// system for this service instance", and annex G.2.3 uses it the same way for HLS. No clause names
// it for MBMS; it is the element of ServiceInstanceType whose definition fits.
//
// The locator must be an MBMS URL, TS 26.347 V18.1.0 clause 8.2.2:
//   mbms-URI = "mbms:" "//" authority path-abempty *( "&" mid-label "=" mid-value ) [ "&label=" resourceURI ]
// "There are no currently defined mid-part pairs; they shall not be present in URLs", except the
// Receive-only Mode form of clause 8.2.4 on mbms://rom.3gpp.org, whose pairs are not checked here.
// Its prefix "is the serviceId of the service", which only the BM-SC knows, so that is not checked.
const MBMS_ROM_AUTHORITY = 'rom.3gpp.org';

function mbmsLocatorProblem(url) {
  const u = String(url || '');
  if (!u.startsWith('mbms://')) return `"${u}" is not an MBMS URL: it must start with mbms:// (TS 26.347 clause 8.2.2).`;
  const at = u.indexOf('&label=');
  const head = at < 0 ? u : u.slice(0, at);
  const label = at < 0 ? null : u.slice(at + '&label='.length);
  const [prefix, ...mid] = head.split('&');
  let parsed;
  try { parsed = new URL('http' + prefix.slice('mbms'.length)); } catch (_) { parsed = null; }
  if (!parsed || !parsed.host || parsed.search || parsed.hash) {
    return `"${u}" is not an MBMS URL: after mbms:// it needs an authority and an optional path, ` +
           `with no query or fragment before any &label= (TS 26.347 clause 8.2.2).`;
  }
  if (mid.length && parsed.host !== MBMS_ROM_AUTHORITY) {
    return `"${u}" carries &name=value pairs, which TS 26.347 clause 8.2.2 says shall not be present ` +
           `outside the Receive-only Mode form on mbms://${MBMS_ROM_AUTHORITY} (clause 8.2.4).`;
  }
  if (mid.some(p => !/^[A-Za-z][A-Za-z0-9]*=.+$/.test(p))) {
    return `"${u}" has a mid-part that is not &name=value (TS 26.347 clause 8.2.2).`;
  }
  if (label !== null) {
    try { new URL(label); } catch (_) {
      return `"${u}": the &label= suffix must be a URI (TS 26.347 clause 8.2.2).`;
    }
  }
  return null;
}

function mbmsProblem(cfg) {
  for (const [i, s] of (cfg.services || []).entries()) {
    for (const [j, inst] of ((s && s.instances) || []).entries()) {
      if (inst && inst.type === 'mbms') {
        const p = mbmsLocatorProblem(inst.url);
        if (p) return `services[${i}].instances[${j}]: ${p}`;
      }
    }
  }
  return null;
}

// TS 103 770 V1.2.1 clause 5.1.4: "A Service shall only be defined once in a Service List but may be
// referenced multiple times with different logical channel numbers." Only enabled services are
// published, so a disabled copy is refused at the publish that enables it.
function uidProblem(cfg) {
  const seen = new Map();
  for (const [i, s] of (cfg.services || []).entries()) {
    if (!s || s.enabled === false) continue;
    if (seen.has(s.uid)) {
      return `services[${seen.get(s.uid)}] and services[${i}] share the UniqueIdentifier "${s.uid}": ` +
             `a service shall only be defined once in a service list (TS 103 770 clause 5.1.4).`;
    }
    seen.set(s.uid, i);
  }
  return null;
}

// ServiceInstance@priority is typed nonNegativeInteger with default="0" (clause 5.5.4) and is
// optional (table 16). An instance without one is written without the attribute; any other value
// has to be a non-negative integer.
const hasPriority = p => p !== undefined && p !== null && p !== '';

function priorityProblem(cfg) {
  for (const [i, s] of (cfg.services || []).entries()) {
    for (const [j, inst] of ((s && s.instances) || []).entries()) {
      if (inst && hasPriority(inst.priority) && !/^\d+$/.test(String(inst.priority))) {
        return `services[${i}].instances[${j}]: priority "${inst.priority}" is not a non-negative ` +
               `integer (ServiceInstance@priority, TS 103 770 clause 5.5.4).`;
      }
    }
  }
  return null;
}

function publishProblem(cfg) {
  return uidProblem(cfg) || priorityProblem(cfg);
}

function assertValidConfigShape(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('config must be an object');
  if (!Array.isArray(cfg.services)) throw new Error('config.services must be an array');
  if (!cfg.epg || typeof cfg.epg !== 'object') throw new Error('config.epg must be an object');
  for (const [i, s] of cfg.services.entries()) {
    if (!s || typeof s !== 'object') throw new Error(`config.services[${i}] must be an object`);
    if (typeof s.uid !== 'string' || !s.uid) throw new Error(`config.services[${i}].uid must be a non-empty string`);
    if (s.instances != null && !Array.isArray(s.instances)) throw new Error(`config.services[${i}].instances must be an array`);
  }
}

function loadConfig() {
  let cfg;
  if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(CONFIG_EXAMPLE)) {
    fs.copyFileSync(CONFIG_EXAMPLE, CONFIG_PATH);
    logger.info('No config.json, started from config.example.json', { path: CONFIG_PATH });
  }
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { logger.error('Config read error', { error: String(e.message || e) }); process.exit(1); }
  try { assertValidConfigShape(cfg); }
  catch (e) { logger.error('Config shape invalid', { error: e.message }); process.exit(1); }
  return cfg;
}

// Write-to-temp-then-rename: rename(2) is atomic on the same filesystem, so a crash or a
// concurrent read can never observe a partially-written file (unlike a direct writeFileSync).
function writeFileAtomic(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, filePath);
}

function saveConfig(cfg) {
  assertValidConfigShape(cfg);
  writeFileAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  // Every config write changes the generated service-list.xml, so bump the
  // conditional-GET timestamp here (covers PUT, logo upload/delete, history restore).
  // Floored to whole seconds because HTTP-date precision is 1s (see /service-list.xml).
  lastSaved = new Date(Math.floor(Date.now() / 1000) * 1000);
}

function saveHistory(cfg) {
  const ts = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-');
  const filename = `config-${ts}.json`;
  try {
    writeFileAtomic(path.join(HISTORY_DIR, filename), JSON.stringify(cfg, null, 2));
    const files = fs.readdirSync(HISTORY_DIR)
      .filter(f => f.startsWith('config-') && f.endsWith('.json'))
      .sort();
    while (files.length > 20) {
      try { fs.unlinkSync(path.join(HISTORY_DIR, files.shift())); } catch (_) {}
    }
  } catch (_) {}
}

let config    = loadConfig();
{
  const problem = cgsidProblem(config);
  // A warning, not a failure: a list already carrying a bad identifier has to stay loadable, or
  // there is no way to open the editor and correct it.
  if (problem) logger.warn('Service list will not validate against the DVB-I schema', { problem });
  const mbms = mbmsProblem(config);
  if (mbms) logger.warn('Service list carries an invalid MBMS locator', { problem: mbms });
  const pub = publishProblem(config);
  if (pub) logger.warn('Service list will not be accepted on its next publish', { problem: pub });
}
// Floored to whole seconds: HTTP-date precision is 1s, so a sub-second lastSaved
// would never satisfy If-Modified-Since and 304s would never fire right after a save.
let lastSaved = new Date(Math.floor(Date.now() / 1000) * 1000);

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(cors());
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => logger.info('request', {
    method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start, ip: req.ip,
  }));
  next();
});
app.use(express.json({ limit: '2mb' }));
// Uploaded logos are operator-supplied files served from this origin, and SVG is among the image
// types accepted, so an uploaded SVG carrying a <script> would execute here if a browser navigated
// to it directly. It cannot when it is only ever an <img> source, which is how the editor and the
// generated list use it, but nothing stops someone opening the URL. These headers make the file
// inert whatever it contains: no scripts, no plugins, no same-origin context, and no content-type
// sniffing. Applied before the static handler so they are set on every response it produces.
app.use('/logos/uploaded', (req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Admin auth ──────────────────────────────────────────────────────────────
// Optional bearer-token gate for sensitive/config endpoints. Backward-compatible: if ADMIN_TOKEN
// is unset the gate is a no-op (current behaviour). Set ADMIN_TOKEN in the environment in any
// deployment reachable beyond a trusted network. Public read routes (/service-list.xml, /epg/*,
// /logos/:id) are intentionally NOT gated.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
// A plain === on a secret returns as soon as two bytes differ, so how long it takes reveals how
// much of the token was right, one byte at a time. timingSafeEqual always compares the whole
// buffer. It requires equal lengths, so the length check is done first and separately: token
// length is not the secret.
function tokenMatches(given) {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(ADMIN_TOKEN, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  if (m && tokenMatches(m[1])) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Small in-memory fixed-window limiter per (ip, bucket). Good enough for a single-process
// admin tool; a multi-instance deployment behind a load balancer would need a shared store.
const _rateBuckets = new Map(); // key -> { count, resetAt }
function rateLimit(bucket, max, windowMs) {
  return (req, res, next) => {
    const key = `${bucket}:${req.ip}`;
    const now = Date.now();
    let b = _rateBuckets.get(key);
    if (!b || now >= b.resetAt) { b = { count: 0, resetAt: now + windowMs }; _rateBuckets.set(key, b); }
    b.count++;
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(Math.max(0, max - b.count)));
    if (b.count > max) {
      res.set('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  };
}
// Periodically drop expired buckets so the Map doesn't grow unbounded.
setInterval(() => { const now = Date.now(); for (const [k, b] of _rateBuckets) if (now >= b.resetAt) _rateBuckets.delete(k); }, 60000).unref();

// ── Logo upload (multer) ──────────────────────────────────────────────────────

const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, LOGOS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    cb(null, `${req.params.id}${ext}`);
  },
});

const LOGO_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const logoUpload = multer({
  storage: logoStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (/^image\//.test(file.mimetype) && LOGO_EXTS.has(ext)) cb(null, true);
    else cb(new Error('Images only (png, jpg, jpeg, gif, webp, svg)'));
  },
});

app.post('/api/logos/upload/:id', requireAdmin, rateLimit('mutate', 30, 60000), (req, res, next) => {
  if (!/^[a-z0-9-]+$/i.test(req.params.id)) return res.status(400).json({ error: 'Invalid service ID' });
  next();
}, logoUpload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const svc = config.services.find(s => s.id === req.params.id);
  if (!svc) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(404).json({ error: 'Service not found' });
  }
  const relativePath = `/logos/uploaded/${req.file.filename}`;
  const prev = JSON.parse(JSON.stringify(config));
  svc.logoUrl = relativePath;
  assignVersions(config, prev, [svc.uid]);
  saveConfig(config);
  res.json({ ok: true, url: relativePath });
});

app.delete('/api/logos/upload/:id', requireAdmin, rateLimit('mutate', 30, 60000), (req, res) => {
  const svc = config.services.find(s => s.id === req.params.id);
  if (svc && svc.logoUrl) {
    const fullPath = path.join(__dirname, 'public', svc.logoUrl.replace(/^\//, ''));
    if (fullPath.startsWith(LOGOS_DIR)) {
      try { fs.unlinkSync(fullPath); } catch (_) {}
    }
    const prev = JSON.parse(JSON.stringify(config));
    svc.logoUrl = '';
    assignVersions(config, prev, [svc.uid]);
    saveConfig(config);
  }
  res.json({ ok: true });
});

// ── Logos (SVG fallback) ──────────────────────────────────────────────────────

app.get('/logos/:id', (req, res, next) => {
  const svc = config.services.find(s => s.id === req.params.id);
  if (svc?.logoUrl) return next();
  const l  = svc
    ? { letters: svc.logoLetters || 'TV', bg: svc.logoBg || '#2c3e50' }
    : { letters: 'TV', bg: '#2c3e50' };
  const fs2 = l.letters.length > 2 ? 22 : 28;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">
  <rect width="80" height="80" rx="12" fill="${l.bg}"/>
  <text x="40" y="54" text-anchor="middle"
        font-family="-apple-system,system-ui,sans-serif"
        font-size="${fs2}" font-weight="700" fill="#fff">${l.letters}</text>
</svg>`);
});

// ── XML helpers ───────────────────────────────────────────────────────────────

function xe(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// DRM shorthand → DVB-I UUID URN (TS 103 770 §5.5.20)
const DRM_UUID = {
  widevine:  'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed',
  playready: 'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95',
  fairplay:  'urn:uuid:94ce86fb-07ff-4f43-adb8-93d2fa968ca2',
  clearkey:  'urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e',
};

// Linked application HowRelated. TS 103 770 V1.2.1 clause 5.2.3.1 requires the RelatedMaterial
// to carry a HowRelated whose @href comes from urn:dvb:metadata:cs:LinkedApplicationCS:2019.
// 1.1 = broadcast-related app (media in parallel); use 1.2 for an app controlling media presentation.
const LINKED_APP_HREF = 'urn:dvb:metadata:cs:LinkedApplicationCS:2019:1.1';

// Genre short name → display label
const GENRE_LABEL = {
  film: 'Film', news: 'News', sports: 'Sports', documentary: 'Documentary',
  entertainment: 'Entertainment', children: 'Children', music: 'Music',
  drama: 'Drama', comedy: 'Comedy', factual: 'Factual',
};

// Genre short name → TVA ContentCS URN. Scheme is urn:tva:metadata:cs:ContentCS:2011 and the
// termIDs are hierarchical (verified against the TVA ContentCS registry). ("children" has no
// dedicated content term in ContentCS — it is an audience attribute — so it maps to the closest
// real content category.)
const CONTENT_CS = 'urn:tva:metadata:cs:ContentCS:2011';
const GENRE_CS = {
  film:          `${CONTENT_CS}:3.4`,      // FICTION/DRAMA
  news:          `${CONTENT_CS}:3.1.1`,    // News
  sports:        `${CONTENT_CS}:3.2`,      // SPORTS
  documentary:   `${CONTENT_CS}:3.1.3`,    // General non-fiction
  entertainment: `${CONTENT_CS}:3.5`,      // AMUSEMENT/ENTERTAINMENT
  children:      `${CONTENT_CS}:3.5`,      // no children content term; closest real bucket
  music:         `${CONTENT_CS}:3.6`,      // Music
  drama:         `${CONTENT_CS}:3.4.1`,    // General light drama
  comedy:        `${CONTENT_CS}:3.5.7`,    // Comedy
  factual:       `${CONTENT_CS}:3.1.3`,    // General non-fiction
};
const GENRE_CS_DEFAULT = `${CONTENT_CS}:3.1.3`; // General non-fiction

function detectMimeType(url) {
  const ext = (url || '').split('?')[0].split('.').pop().toLowerCase();
  const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
  return map[ext] || 'image/png';
}

function buildServiceList(base, cfg, opts = {}) {
  const version = String(cfg.version || 1);
  const listId  = cfg.listId || `tag:dvbi.example,2024:servicelist:default`;
  const requestedCountry = (opts.targetCountry || '').toUpperCase().slice(0, 3);

  // Server-side regionalisation, which TS 103 770 §5.6.4.1 makes optional for a Service List
  // Server: it may tailor the list before providing it to the client using geographic
  // information. The clause names postcode, receivable multiplex and region identifier as the
  // information a client may supply; the targetCountry query parameter used here is this
  // server's own, not one the specification defines.
  let enabled = cfg.services.filter(s => s.enabled !== false);
  if (requestedCountry) {
    enabled = enabled.filter(s => !s.targetRegion || s.targetRegion.toUpperCase().startsWith(requestedCountry));
  }

  // Build per-region LCNTables: one table per TargetRegion, plus a global table for services
  // with none. TS 103 770 V1.2.1 clause 5.5.12, table 25, row TargetRegion: a table names the
  // regions where it applies, and a table without one is applicable anywhere.
  const regionLCNMap = {};
  const globalLCNEntries = [];
  for (const s of enabled) {
    if (s.lcn == null) continue;
    const entry = { lcn: s.lcn, uid: s.uid };
    if (s.targetRegion) {
      if (!regionLCNMap[s.targetRegion]) regionLCNMap[s.targetRegion] = [];
      regionLCNMap[s.targetRegion].push(entry);
    } else {
      globalLCNEntries.push(entry);
    }
  }
  const byLCN = arr => arr.slice().sort((a, b) => a.lcn - b.lcn);
  let lcnTableListContent = '';
  for (const [regionId, entries] of Object.entries(regionLCNMap)) {
    const rows = byLCN(entries).map(e => `      <LCN channelNumber="${e.lcn}" serviceRef="${xe(e.uid)}"/>`).join('\n');
    lcnTableListContent += `
    <LCNTable>
      <TargetRegion>${xe(regionId)}</TargetRegion>
${rows}
    </LCNTable>`;
  }
  if (globalLCNEntries.length) {
    const rows = byLCN(globalLCNEntries).map(e => `      <LCN channelNumber="${e.lcn}" serviceRef="${xe(e.uid)}"/>`).join('\n');
    lcnTableListContent += `
    <LCNTable>
${rows}
    </LCNTable>`;
  }
  if (!lcnTableListContent) lcnTableListContent = '\n    <LCNTable/>';

  // RegionList: RegionListType requires @version; Region is CountryRegionType requiring @countryCodes
  // (tva:ISO-3166-List = comma-separated [A-Z]{3} codes). Source the country from config; fall back
  // to the regionID's leading token (e.g. GBR-ENG -> GBR) when no list-level country is configured.
  const regions = [...new Set(enabled.filter(s => s.targetRegion).map(s => s.targetRegion))];
  const listCC  = (cfg.targetCountry || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
  const regionList = regions.length ? `
  <RegionList version="${xe(version)}">
${regions.map(r => {
    const cc = listCC || (String(r).split(/[-_ ]/)[0] || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'ZZZ';
    return `    <Region regionID="${xe(r)}" countryCodes="${xe(cc)}" xml:lang="en">
      <RegionName>${xe(r)}</RegionName>
    </Region>`;
  }).join('\n')}
  </RegionList>` : '';

  // LanguageList: BCP-47 tags for which metadata is available (TS 103 770 §5.5.1)
  const langSet = new Set([cfg.listLang || 'en']);
  for (const s of enabled) {
    if (s.languages?.length) {
      for (const l of s.languages) if (l.lang) langSet.add(l.lang);
    }
  }
  const languageListEl = `
  <LanguageList>
${[...langSet].map(l => `    <Language>${xe(l)}</Language>`).join('\n')}
  </LanguageList>`;

  const serviceBlocks = enabled.map(s => {
    // logoUrl is either absolute (what the editor's "Logo Image URL" field invites) or a path on
    // this server (what the logo upload stores, e.g. /logos/uploaded/x.png). Only the relative form
    // is resolved against base: prefixing base onto an absolute URL produced a malformed MediaUri
    // of the form "http://hosthttp://host/...", which is not a valid xs:anyURI and fails schema
    // validation, while still looking plausible in the rendered XML.
    const logoAbs  = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s.logoUrl || '') || (s.logoUrl || '').startsWith('//');
    const logoUri  = s.logoUrl
      ? (logoAbs ? xe(s.logoUrl) : `${xe(base)}${xe(s.logoUrl)}`)
      : `${xe(base)}/logos/${xe(s.id)}`;
    const logoType = s.logoUrl ? detectMimeType(s.logoUrl) : 'image/svg+xml';

    // ServiceInstance blocks — XSD sequence: DisplayName, ContentProtection, ContentAttributes, delivery
    const instanceBlocks = (s.instances || []).map(inst => {
      // ContentProtection: multiple blocks for multi-DRM (TS 103 770 §5.5.20); @encryptionScheme mandatory
      // drmSystems array is the preferred format; fall back to single inst.protection for old data
      const drmEntries = inst.drmSystems?.length
        ? inst.drmSystems
        : (inst.protection && inst.protection !== 'none' ? [{ system: inst.protection, encryptionScheme: inst.encryptionScheme || 'cenc' }] : []);
      const protEl = drmEntries.map(drm => `
      <ContentProtection>
        <DRMSystemId encryptionScheme="${xe(drm.encryptionScheme || 'cenc')}">${xe(DRM_UUID[drm.system] || drm.system)}</DRMSystemId>
      </ContentProtection>`).join('');

      // ContentAttributes/AccessibilityAttributes (tva: namespace). AccessibilityAttributesType
      // sequence: SubtitleAttributes then AudioDescriptionAttributes (order-sensitive).
      let accessEl = '';
      if (inst.hasAudioDescription || inst.hasHardOfHearing) {
        // AudioDescriptionAttributesType requires a child AudioAttributes (empty is valid).
        const adPart = inst.hasAudioDescription
          ? `\n          <tva:AudioDescriptionAttributes><tva:AudioAttributes/></tva:AudioDescriptionAttributes>` : '';
        const hohPart = inst.hasHardOfHearing ? (() => {
          // SubtitleAttributesType sequence: Carriage, Coding(1..n), SubtitleLanguage, Purpose*, SuitableForTTS.
          // Carriage codes (SubtitleCarriageCS:2023): 1=application, 2=in TS, 3=ISOBMFF/DASH, 5=open/in-video.
          const carriageType = inst.subtitleCarriage || 3;
          const subLang = inst.subtitleLanguage || s.languages?.[0]?.lang || cfg.listLang || 'en';
          return `\n          <tva:SubtitleAttributes>
            <tva:Carriage href="urn:tva:metadata:cs:SubtitleCarriageCS:2023:${xe(String(carriageType))}"/>
            <tva:Coding href="urn:tva:metadata:cs:SubtitleCodingFormatCS:2023:2.1.3"/>
            <tva:SubtitleLanguage>${xe(subLang)}</tva:SubtitleLanguage>
            <tva:Purpose href="urn:tva:metadata:cs:SubtitlePurposeCS:2023:2"/>
            <tva:SuitableForTTS>false</tva:SuitableForTTS>
          </tva:SubtitleAttributes>`;
        })() : '';
        // AccessibilityAttributes is a DVB-I element (ContentAttributesType) whose TYPE is
        // tva:AccessibilityAttributesType, so the wrapper is unprefixed (default ns) while its
        // children (SubtitleAttributes/AudioDescriptionAttributes) remain in the tva: namespace.
        accessEl = `
      <ContentAttributes>
        <AccessibilityAttributes>${hohPart}${adPart}
        </AccessibilityAttributes>
      </ContentAttributes>`;
      }

      // Availability + SubscriptionPackage belong to ServiceInstanceType (after ContentAttributes),
      // not to ServiceType. Emit them per instance, in sequence: ...ContentProtection, ContentAttributes,
      // Availability, SubscriptionPackage, (delivery parameters).
      let availEl = '';
      if (s.availableFrom || s.availableTo) {
        const fromAttr = s.availableFrom ? ` validFrom="${xe(s.availableFrom)}"` : '';
        const toAttr   = s.availableTo   ? ` validTo="${xe(s.availableTo)}"`     : '';
        availEl = `\n      <Availability>\n        <Period${fromAttr}${toAttr}/>\n      </Availability>`;
      }
      const subPkgEl = s.subscriptionPackage
        ? `\n      <SubscriptionPackage>${xe(s.subscriptionPackage)}</SubscriptionPackage>` : '';

      const prioAttr = hasPriority(inst.priority) ? ` priority="${xe(String(inst.priority))}"` : '';
      const head = `
    <ServiceInstance${prioAttr}>
      <DisplayName>${xe(inst.label || s.name)}</DisplayName>${protEl}${accessEl}${availEl}${subPkgEl}`;

      // URI is declared in the servicediscovery-types:2023 namespace (ExtendedURIType / m3u8RefType),
      // so it must carry the dvbisd-t prefix, not the default 2024 namespace.
      if (inst.type === 'dash') {
        return `${head}
      <DASHDeliveryParameters>
        <UriBasedLocation contentType="application/dash+xml">
          <dvbisd-t:URI>${xe(inst.url)}</dvbisd-t:URI>
        </UriBasedLocation>
      </DASHDeliveryParameters>
    </ServiceInstance>`;
      }

      // 5G Broadcast delivery: the mbms:// locator of the MBMS User Service (see mbmsLocatorProblem).
      // @contentType is optional and left out: table 33a lets the payload type be "determined through
      // some component of the element value", here the mbms scheme.
      // A unicast copy of the same service is simply another instance with a lower @priority.
      if (inst.type === 'mbms') {
        return `${head}
      <IdentifierBasedDeliveryParameters>${xe(inst.url)}</IdentifierBasedDeliveryParameters>
    </ServiceInstance>`;
      }

      if (inst.type === 'multicast') {
        // Parse udp://address:port into MulticastTSDeliveryParameters/IPMulticastAddress (McastType:
        // attributes are Address/Port, capital-initial per BasicMulticastAddressAttributesType).
        let address = '', port = '5004';
        try {
          const u = new URL(inst.url);
          address = u.hostname;
          if (u.port) port = u.port;
        } catch (_) {
          const m = inst.url.match(/\/\/([^:/?#]+)(?::(\d+))?/);
          if (m) { address = m[1]; if (m[2]) port = m[2]; }
        }
        return `${head}
      <MulticastTSDeliveryParameters>
        <IPMulticastAddress Address="${xe(address)}" Port="${xe(port)}"/>
      </MulticastTSDeliveryParameters>
    </ServiceInstance>`;
      }

      // HLS — namespace vnd:apple:mpegurl per Annex G.2.2
      return `${head}
      <OtherDeliveryParameters extensionName="vnd.apple.mpegurl" xsi:type="hls:m3u8RefType">
        <hls:UriBasedLocation contentType="application/vnd.apple.mpegurl">
          <dvbisd-t:URI>${xe(inst.url)}</dvbisd-t:URI>
        </hls:UriBasedLocation>
      </OtherDeliveryParameters>
    </ServiceInstance>`;
    }).join('');

    // Multi-language ServiceName
    const nameEls = (s.languages && s.languages.length)
      ? s.languages.map(l => `\n    <ServiceName xml:lang="${xe(l.lang)}">${xe(l.name)}</ServiceName>`).join('')
      : `\n    <ServiceName>${xe(s.name)}</ServiceName>`;

    const providerEl = `\n    <ProviderName>${xe(s.provider)}</ProviderName>`;

    // Logo RelatedMaterial — HowRelated and MediaLocator are in TVA namespace (TS 103 770 §6.10 / TS 102 822)
    const logoEl = `
    <RelatedMaterial>
      <tva:HowRelated href="urn:dvb:metadata:cs:HowRelatedCS:2021:1001.2"/>
      <tva:MediaLocator>
        <tva:MediaUri contentType="${logoType}">${logoUri}</tva:MediaUri>
      </tva:MediaLocator>
    </RelatedMaterial>`;

    // Linked application RelatedMaterial (TS 103 770 V1.2.1 clause 5.2.3.1): app launched by the
    // receiver.
    // contentType is the field the receiver consumes; HowRelated marks it as a linked app.
    const linkedAppEl = s.linkedApp?.url ? `
    <RelatedMaterial>
      <tva:HowRelated href="${LINKED_APP_HREF}"/>
      <tva:MediaLocator>
        <tva:MediaUri contentType="${xe(s.linkedApp.contentType || 'text/html')}">${xe(s.linkedApp.url)}</tva:MediaUri>
      </tva:MediaLocator>
    </RelatedMaterial>` : '';

    // ServiceGenre with TVA ContentCS URN (TS 103 770 §5.5.2 element name + TS 103 770 §6.11.5 CS scheme)
    const genreEl = s.genre
      ? `
    <ServiceGenre href="${GENRE_CS[s.genre] || GENRE_CS_DEFAULT}">
      <tva:Name xml:lang="en">${xe(GENRE_LABEL[s.genre] || s.genre)}</tva:Name>
    </ServiceGenre>` : '';

    // ServiceType: radio → linear-radio per ServiceTypeCS (§D.4)
    // Map to real ServiceTypeCS:2019 termIDs (linear, linear-radio, ondemand, ondemand-radio, ...).
    // 'nonlinear' is NOT a scheme term — on-demand services use 'ondemand'.
    const SERVICE_TYPE_CS = { linear: 'linear', radio: 'linear-radio', nonlinear: 'ondemand', ondemand: 'ondemand', 'linear-radio': 'linear-radio', data: 'data' };
    const svcTypeValue = SERVICE_TYPE_CS[s.type] || 'linear';
    const serviceTypeEl = `\n    <ServiceType href="urn:dvb:metadata:cs:ServiceTypeCS:2019:${xe(svcTypeValue)}"/>`;

    // ContentGuideServiceRef at Service level (TS 103 770 §5.5.2, not inside ServiceInstance)
    const cgsRef = s.customEpgUrl ? `epg-${s.id}` : cfg.epg.id;
    const cgsRefEl = `\n    <ContentGuideServiceRef>${xe(cgsRef)}</ContentGuideServiceRef>`;

    // ParentalRating (TS 103 770 §5.5.28) — service-list element; MinimumAge has no tva: prefix here
    const pgEl = s.parentalRating != null && s.parentalRating !== '' && s.parentalRating !== null
      ? `
    <ParentalRating>
      <MinimumAge>${xe(String(s.parentalRating))}</MinimumAge>
    </ParentalRating>` : '';

    // TargetRegion is RegionIdRefType: the region id is the element's TEXT, not a regionID attribute.
    const regionEl = s.targetRegion
      ? `\n    <TargetRegion>${xe(s.targetRegion)}</TargetRegion>` : '';

    // ServiceType sequence (no ServiceRestriction/SubscriptionPackage/Availability here — those moved
    // to ServiceInstance): UniqueIdentifier, ServiceInstance*, TargetRegion*, ServiceName+, ProviderName,
    // RelatedMaterial* (logo, then linked app), ServiceGenre*, ServiceType*, ContentGuideServiceRef?, ParentalRating?
    return `
  <!-- ${xe(s.name)} -->
  <Service version="${xe(String(s.version || 1))}">
    <UniqueIdentifier>${xe(s.uid)}</UniqueIdentifier>${instanceBlocks}${regionEl}${nameEls}${providerEl}${logoEl}${linkedAppEl}${genreEl}${serviceTypeEl}${cgsRefEl}${pgEl}
  </Service>`;
  }).join('');

  // Per-service ContentGuideSources for services with a custom EPG URL
  const perSvcCGS = enabled
    .filter(s => s.customEpgUrl)
    .map(s => `
    <ContentGuideSource CGSID="epg-${xe(s.id)}">
      <ProviderName>${xe(s.provider || s.name)}</ProviderName>
      <ScheduleInfoEndpoint contentType="application/xml">
        <dvbisd-t:URI>${xe(s.customEpgUrl)}</dvbisd-t:URI>
      </ScheduleInfoEndpoint>
    </ContentGuideSource>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<ServiceList
  xmlns="urn:dvb:metadata:servicediscovery:2024"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:hls="vnd:apple:mpegurl"
  xmlns:tva="urn:tva:metadata:2024"
  xmlns:dvbisd-t="urn:dvb:metadata:servicediscovery-types:2023"
  id="${xe(listId)}"
  version="${xe(version)}" xml:lang="${xe(cfg.listLang || 'en')}">

  <Name>${xe(cfg.listName)}</Name>
  <ProviderName>${xe(cfg.providerName)}</ProviderName>${languageListEl}${regionList}

  <LCNTableList>${lcnTableListContent}
  </LCNTableList>

  <ContentGuideSourceList>
    <ContentGuideSource CGSID="${xe(cfg.epg.id)}">
      <ProviderName>${xe(cfg.epg.providerName)}</ProviderName>
      <ScheduleInfoEndpoint contentType="application/xml">
        <dvbisd-t:URI>${xe(base)}/epg/schedule</dvbisd-t:URI>
      </ScheduleInfoEndpoint>
      <ProgramInfoEndpoint contentType="application/xml">
        <dvbisd-t:URI>${xe(base)}/epg/nownext</dvbisd-t:URI>
      </ProgramInfoEndpoint>
    </ContentGuideSource>${perSvcCGS}
  </ContentGuideSourceList>
${serviceBlocks}

</ServiceList>`;
}

// TS 103 770 V1.2.1 clause 5.5.1, table 14, row @version: "The version number of the service list.
// Shall be incremented for every published change." Table 15 says the same of Service@version and
// table 38 of RegionList@version, which is written from the list's. Every path that publishes
// (editor or API save, logo upload and removal, history restore) goes through here, so none can
// republish a changed list or service under a number already used.
//
// A service has changed when its rendered Service element differs from the one last published,
// version aside, or when the caller names it (a new logo file can sit at an unchanged URL). Its
// version never goes below the last published one, so restoring an older copy moves it forward.
function renderedServices(cfg) {
  const out = new Map();
  const re = /<Service version="[^"]*">\s*<UniqueIdentifier>([^<]*)<\/UniqueIdentifier>([\s\S]*?)<\/Service>/g;
  for (const m of buildServiceList('', cfg).matchAll(re)) out.set(m[1], m[2]);
  return out;
}

function assignVersions(next, prev, changedUids = []) {
  next.version = (Number(prev.version) || 0) + 1;
  const before = renderedServices(prev);
  const after  = renderedServices(next);
  for (const s of next.services) {
    const old = (prev.services || []).find(p => p && p.uid === s.uid);
    if (!old) continue;
    const was = Number(old.version) || 1;
    const is  = Number(s.version) || 1;
    const changed = changedUids.includes(s.uid) || before.get(xe(s.uid)) !== after.get(xe(s.uid));
    s.version = changed ? Math.max(is, was + 1) : Math.max(is, was);
  }
}

// TS 103 770 V1.2.1 clause 5.1.2: "A Service List shall be made available using HTTP according to
// clause 7.3 at a Service List URL, using the Media Type (MIME type) application/vnd.dvb.dvbisl+xml."
const SERVICE_LIST_MEDIA_TYPE = 'application/vnd.dvb.dvbisl+xml';

app.get('/service-list.xml', (req, res) => {
  // Conditional GET per TS 103 770 V1.2.1 clause 4.3.2.2, If-Modified-Since headers.
  // A184r2 clause 4.11 covers when a client refreshes the list.
  const ifModSince = req.headers['if-modified-since'];
  if (ifModSince) {
    const d = new Date(ifModSince);
    if (!isNaN(d.getTime()) && lastSaved.getTime() <= d.getTime()) {
      return res.status(304).end();
    }
  }
  const base = `${req.protocol}://${req.get('host')}`;
  const targetCountry = req.query.TargetCountry || req.query.targetCountry || '';
  res.setHeader('Content-Type', SERVICE_LIST_MEDIA_TYPE);
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Last-Modified', lastSaved.toUTCString());
  res.send(buildServiceList(base, config, { targetCountry }));
});

// ── EPG schedule ──────────────────────────────────────────────────────────────

function msDur(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (!h && !m && !sec) return 'PT0S';
  return `PT${h ? h + 'H' : ''}${m ? m + 'M' : ''}${sec ? sec + 'S' : ''}`;
}

function buildSchedule(progs) {
  const now = Date.now();
  let t = now - (now % 3600000) - 7200000;
  const items = [];
  let i = 0;
  while (t < now + 8 * 3600000) {
    const progIdx = i % progs.length;
    const p = progs[progIdx];
    const durMs = p.dur * 60000;
    items.push({ ...p, startMs: t, endMs: t + durMs, durMs, progIdx });
    t += durMs; i++;
  }
  return items;
}

// An empty TV-Anytime document, used for both "this service carries no programmes" and "no such
// service". @xml:lang is required on TVAMainType by the TV-Anytime schema (tva_metadata_3-1_2024.xsd:
// <attribute ref="xml:lang" use="required"/>), and TS 103 770 V1.2.1 clause 6.10.1.2 states:
// "TV-Anytime requires that the default language used in a TV-Anytime document is specified at the
// top level with the TVAMain element using the @xml:lang attribute." Emitting one without it makes
// the response fail schema validation, which is what this helper exists to prevent repeating.
function emptyTVAMain(cfg) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<TVAMain xmlns="urn:tva:metadata:2024" xmlns:mpeg7="urn:tva:mpeg7:2008" xml:lang="${xe(cfg.listLang || 'en')}"/>`;
}

app.get('/epg/schedule', (req, res) => {
  const serviceId = req.query.sid || req.query.serviceId; // sid is spec-compliant (TS 103 770 §6.5.2.2)
  const svc   = config.services.find(s => s.uid === serviceId);
  const progs = svc?.epgPrograms;
  // A service that exists but carries no programmes is not an error, and must not be answered with
  // 404: per TS 103 770 V1.2.1 clause 4.3.3.4, a 404 from a ContentGuideSource API URL makes the
  // client re-acquire the whole Service List and then apply the back-off model of clause 4.3.3.7.
  // Spending that on the normal "nothing scheduled" case is wrong, so an empty but valid document
  // is returned with 200 instead. 404 is kept for a sid that names no service in this list, which
  // is the condition that clause actually describes.
  if (!svc) return res.status(404).type('xml').send(emptyTVAMain(config));
  if (!progs?.length) return res.type('xml').send(emptyTVAMain(config));
  const sched = buildSchedule(progs);

  // Build series CRIDs for GroupInformation/MemberOf (TS 103 770 §6.10.17)
  const seriesCrids = {};
  let _sIdx = 0;
  for (const p of progs) {
    if (!p.seriesTitle) continue;
    const key = `${p.seriesTitle}::${p.seriesNumber || ''}`;
    if (!seriesCrids[key]) seriesCrids[key] = `crid://dvbi.example.com/2024/series/${++_sIdx}`;
  }

  const progInfo = sched.map(p => {
    const imgEl = p.image
      ? `\n        <RelatedMaterial>
          <HowRelated href="urn:tva:metadata:cs:HowRelatedCS:2012:19"/>
          <MediaLocator><MediaUri>${xe(p.image)}</MediaUri></MediaLocator>
        </RelatedMaterial>` : '';
    const pgEl = p.parentalAge != null && p.parentalAge !== ''
      ? `\n        <ParentalGuidance><mpeg7:MinimumAge>${xe(String(p.parentalAge))}</mpeg7:MinimumAge></ParentalGuidance>` : '';
    // MemberOf replaces flat SeriesNumber/EpisodeNumber/SeriesTitle per TS 103 770 §6.10.17
    let memberOfEl = '';
    if (p.seriesTitle) {
      const key  = `${p.seriesTitle}::${p.seriesNumber || ''}`;
      const crid = seriesCrids[key];
      const idxA = (p.episodeNumber != null && p.episodeNumber !== '') ? ` index="${xe(String(p.episodeNumber))}"` : '';
      // MemberOf is a child of ProgramInformation (after BasicDescription), not of BasicDescription
      memberOfEl = `\n      <MemberOf crid="${xe(crid)}"${idxA}/>`;
    }
    // In TVAMain the default namespace IS urn:tva:metadata:2024, so Name takes no prefix
    // (the tva: prefix is only declared in the service list, not here)
    const genreEl = p.genre
      ? `\n        <Genre href="${GENRE_CS[p.genre] || GENRE_CS_DEFAULT}"><Name xml:lang="en">${xe(GENRE_LABEL[p.genre] || p.genre)}</Name></Genre>` : '';
    // BasicContentDescriptionType sequence: Title, Synopsis, ..., Genre, ParentalGuidance, ..., RelatedMaterial.
    // MemberOf is moved out to be a ProgramInformation child after BasicDescription.
    return `
    <ProgramInformation programId="crid://dvbi.example.com/2024/prog/${p.progIdx}">
      <BasicDescription>
        <Title type="main">${xe(p.title)}</Title>
        <Synopsis length="short">${xe(p.desc)}</Synopsis>${genreEl}${pgEl}${imgEl}
      </BasicDescription>${memberOfEl}
    </ProgramInformation>`;
  }).join('');

  // GroupInformationTable for series referenced via MemberOf
  const groupInfoItems = Object.entries(seriesCrids).map(([key, crid]) => {
    const sep    = key.lastIndexOf('::');
    const sTitle = key.slice(0, sep);
    const sNum   = key.slice(sep + 2);
    const seasonLabel = sNum ? ` (Season ${sNum})` : '';
    // GroupInformationType sequence: GroupType first, then BasicDescription. GroupType is an abstract
    // type, so it needs xsi:type naming the concrete ProgramGroupTypeType, which carries @value (not @href).
    return `
    <GroupInformation groupId="${xe(crid)}" ordered="true">
      <GroupType xsi:type="tva:ProgramGroupTypeType" value="series"/>
      <BasicDescription>
        <Title type="main">${xe(sTitle)}${xe(seasonLabel)}</Title>
      </BasicDescription>
    </GroupInformation>`;
  }).join('');
  const groupInfoTableEl = groupInfoItems ? `
    <GroupInformationTable>${groupInfoItems}
    </GroupInformationTable>` : '';

  const catchupEvents = sched.filter(p => p.catchupUrl);
  // OnDemandProgram full structure per TS 103 770 §6.10.8.2
  const catchupPrograms = catchupEvents.map(p => {
    const startAvail = new Date(p.startMs).toISOString();
    const endAvail   = new Date(p.endMs + 30 * 86400000).toISOString();
    return `
      <OnDemandProgram>
        <Program crid="crid://dvbi.example.com/2024/prog/${p.progIdx}"/>
        <ProgramURL>${xe(p.catchupUrl)}</ProgramURL>
        <InstanceDescription/>
        <PublishedDuration>${msDur(p.durMs)}</PublishedDuration>
        <StartOfAvailability>${startAvail}</StartOfAvailability>
        <EndOfAvailability>${endAvail}</EndOfAvailability>
        <DeliveryMode>streaming</DeliveryMode>
        <Free value="true"/>
      </OnDemandProgram>`;
  }).join('');

  const nowMs = Date.now();
  const schedEvents = sched.map(p => {
    // Emit ActualStartTime/ActualEndTime for events that have started (A184r2 §4.5)
    // For generated schedules, actuals equal published values (no real broadcast delay to model)
    const actualEl = p.startMs <= nowMs
      ? `\n        <ActualStartTime>${new Date(p.startMs).toISOString()}</ActualStartTime>
        <ActualEndTime>${new Date(p.endMs).toISOString()}</ActualEndTime>` : '';
    return `
      <ScheduleEvent>
        <Program crid="crid://dvbi.example.com/2024/prog/${p.progIdx}"/>
        <PublishedStartTime>${new Date(p.startMs).toISOString()}</PublishedStartTime>
        <PublishedDuration>${msDur(p.durMs)}</PublishedDuration>${actualEl}
      </ScheduleEvent>`;
  }).join('');

  res.type('xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<TVAMain xmlns="urn:tva:metadata:2024" xmlns:mpeg7="urn:tva:mpeg7:2008" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:tva="urn:tva:metadata:2024" xml:lang="en">
  <ProgramDescription>
    <ProgramInformationTable>${progInfo}
    </ProgramInformationTable>${groupInfoTableEl}
    <ProgramLocationTable>
      <Schedule serviceIDRef="${xe(serviceId)}"
                start="${new Date(sched[0].startMs).toISOString()}"
                end="${new Date(sched[sched.length - 1].endMs).toISOString()}">
        ${schedEvents}
      </Schedule>${catchupPrograms ? '\n' + catchupPrograms : ''}
    </ProgramLocationTable>
  </ProgramDescription>
</TVAMain>`);
});

// ── EPG now/next (TS 103 770 §6.5.3) ────────────────────────────────────────────────────

app.get('/epg/nownext', (req, res) => {
  const serviceId = req.query.sid || req.query.serviceId;
  const svc   = config.services.find(s => s.uid === serviceId);
  const progs = svc?.epgPrograms;
  // Same split as /epg/schedule above: unknown service is 404, known service with nothing to
  // announce is an empty document with 200.
  if (!svc) return res.status(404).type('xml').send(emptyTVAMain(config));
  if (!progs?.length) return res.type('xml').send(emptyTVAMain(config));
  const sched = buildSchedule(progs);
  const now   = Date.now();
  const curIdx = sched.findIndex(p => p.startMs <= now && p.endMs > now);
  const toEmit = curIdx >= 0 ? sched.slice(curIdx, curIdx + 2) : sched.slice(0, 1);
  if (!toEmit.length) return res.type('xml').send(emptyTVAMain(config));
  const progInfo2 = toEmit.map(p => {
    const pgEl = p.parentalAge != null && p.parentalAge !== ''
      ? `\n        <ParentalGuidance><mpeg7:MinimumAge>${xe(String(p.parentalAge))}</mpeg7:MinimumAge></ParentalGuidance>` : '';
    return `
    <ProgramInformation programId="crid://dvbi.example.com/2024/prog/${p.progIdx}">
      <BasicDescription>
        <Title type="main">${xe(p.title)}</Title>
        <Synopsis length="short">${xe(p.desc)}</Synopsis>${pgEl}
      </BasicDescription>
    </ProgramInformation>`;
  }).join('');
  const nowMs2 = Date.now();
  const schedEvents2 = toEmit.map(p => {
    const actualEl2 = p.startMs <= nowMs2
      ? `\n        <ActualStartTime>${new Date(p.startMs).toISOString()}</ActualStartTime>
        <ActualEndTime>${new Date(p.endMs).toISOString()}</ActualEndTime>` : '';
    return `
      <ScheduleEvent>
        <Program crid="crid://dvbi.example.com/2024/prog/${p.progIdx}"/>
        <PublishedStartTime>${new Date(p.startMs).toISOString()}</PublishedStartTime>
        <PublishedDuration>${msDur(p.durMs)}</PublishedDuration>${actualEl2}
      </ScheduleEvent>`;
  }).join('');
  res.type('xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<TVAMain xmlns="urn:tva:metadata:2024" xmlns:mpeg7="urn:tva:mpeg7:2008" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:tva="urn:tva:metadata:2024" xml:lang="en">
  <ProgramDescription>
    <ProgramInformationTable>${progInfo2}
    </ProgramInformationTable>
    <ProgramLocationTable>
      <Schedule serviceIDRef="${xe(serviceId)}"
                start="${new Date(toEmit[0].startMs).toISOString()}"
                end="${new Date(toEmit[toEmit.length - 1].endMs).toISOString()}">
${schedEvents2}
      </Schedule>
    </ProgramLocationTable>
  </ProgramDescription>
</TVAMain>`);
});

// ── Admin API ─────────────────────────────────────────────────────────────────

app.get('/api/config', requireAdmin, (req, res) => res.json(config));

// Provenance info for the UI: where the editable data model actually lives on disk. Kept as a
// separate endpoint (not merged into /api/config's response) so it can never round-trip into a
// PUT and get accidentally persisted into config.json.
app.get('/api/config/meta', requireAdmin, (req, res) => {
  try {
    const st = fs.statSync(CONFIG_PATH);
    res.json({ path: CONFIG_PATH, lastModified: st.mtime.toISOString(), sizeBytes: st.size, version: config.version || null });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Templates: ready-made starting points kept as JSON files in templates/, listed and loaded by the
// editor's Templates control. Two kinds, distinguished by the file's own "kind":
//   "service"  one service, opened in the editor pre-filled
//   "list"     a whole line-up, replacing the services in the current list
// Read from disk on each request rather than cached at startup, so editing or adding a file changes
// what the control offers without restarting the server. Nothing here writes to config.json: a
// template only reaches the published list once the operator saves it.

function readTemplate(file) {
  const raw = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8'));
  const kind = raw.kind === 'list' ? 'list' : 'service';
  const body = kind === 'list' ? raw.list : raw.service;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`${file} must contain a "${kind}" object`);
  }
  if (_hasUnsafeKeys(body)) throw new Error(`${file} contains disallowed keys`);
  const services = kind === 'list' ? (Array.isArray(body.services) ? body.services : []) : [body];
  return { file, kind, name: raw.name || file.replace(/\.json$/, ''), services, body };
}

app.get('/api/templates', requireAdmin, (req, res) => {
  let files;
  try { files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json')).sort(); }
  catch { return res.json([]); }   // no templates directory is not an error, just nothing to offer
  const out = [];
  for (const file of files) {
    // One unreadable file must not hide the rest, so report it in place rather than failing the
    // whole listing: the operator can still load the others and can see which file to fix.
    try {
      const t = readTemplate(file);
      out.push({ file: t.file, kind: t.kind, name: t.name, serviceCount: t.services.length });
    } catch (e) {
      logger.warn('Unreadable template', { file, error: String(e.message || e) });
      out.push({ file, kind: 'invalid', name: `${file} (unreadable)`, serviceCount: 0, error: String(e.message || e) });
    }
  }
  res.json(out);
});

app.get('/api/templates/:file', requireAdmin, (req, res) => {
  const file = req.params.file;
  // Confine the read to templates/: the name is a single .json filename, never a path.
  if (!/^[A-Za-z0-9._-]+\.json$/.test(file) || file.includes('..')) {
    return res.status(400).json({ error: 'Invalid template name' });
  }
  try {
    const t = readTemplate(file);
    res.json({ file: t.file, kind: t.kind, name: t.name, [t.kind]: t.body });
  } catch (e) {
    const code = e.code === 'ENOENT' ? 404 : 500;
    logger.error('Template read error', { file, error: String(e.message || e) });
    res.status(code).json({ error: code === 404 ? 'No such template' : String(e.message || e) });
  }
});

// Reject configs carrying prototype-pollution keys before they are stored/merged (defense-in-depth)
function _hasUnsafeKeys(obj, depth = 0) {
  if (depth > 8 || !obj || typeof obj !== 'object') return false;
  for (const k of Object.keys(obj)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') return true;
    if (_hasUnsafeKeys(obj[k], depth + 1)) return true;
  }
  return false;
}

app.put('/api/config', requireAdmin, rateLimit('mutate', 30, 60000), (req, res) => {
  try {
    const updated = req.body;
    if (!updated || typeof updated !== 'object' || Array.isArray(updated)) return res.status(400).json({ error: 'Invalid body' });
    if (_hasUnsafeKeys(updated)) return res.status(400).json({ error: 'Config contains disallowed keys' });
    if (!Array.isArray(updated.services)) return res.status(400).json({ error: 'Config must have a services array' });
    const cgsid = cgsidProblem(updated);
    if (cgsid) return res.status(400).json({ error: cgsid });
    const mbms = mbmsProblem(updated);
    if (mbms) return res.status(400).json({ error: mbms });
    const pub = publishProblem(updated);
    if (pub) return res.status(400).json({ error: pub });
    assertValidConfigShape(updated);
    assignVersions(updated, config);
    saveHistory(config); // snapshot previous state
    config = updated;
    saveConfig(config); // also bumps lastSaved
    const base = `${req.protocol}://${req.get('host')}`;
    res.json({ ok: true, version: config.version, xml: buildServiceList(base, config) });
  } catch (e) {
    // assertValidConfigShape throws a plain validation Error; distinguish from real server errors
    res.status(e instanceof Error && /^config/.test(e.message) ? 400 : 500).json({ error: String(e.message || e) });
  }
});

app.get('/api/history', requireAdmin, (req, res) => {
  try {
    const files = fs.readdirSync(HISTORY_DIR)
      .filter(f => f.startsWith('config-') && f.endsWith('.json'))
      .sort()
      .reverse();
    const entries = files.map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8'));
        return { filename: f, version: data.version || null, listName: data.listName || '', services: (data.services || []).length };
      } catch { return { filename: f, version: null, listName: '', services: 0 }; }
    });
    res.json(entries);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/history/restore/:filename', requireAdmin, rateLimit('mutate', 30, 60000), (req, res) => {
  const { filename } = req.params;
  if (!/^config-[\w.-]+\.json$/.test(filename)) return res.status(400).json({ error: 'Invalid filename' });
  const filepath = path.join(HISTORY_DIR, filename);
  try {
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    if (_hasUnsafeKeys(data)) return res.status(400).json({ error: 'Snapshot contains disallowed keys' });
    const pub = publishProblem(data);
    if (pub) return res.status(400).json({ error: pub });
    assertValidConfigShape(data);
    assignVersions(data, config);
    saveHistory(config); // snapshot current state before restoring
    config = data;
    saveConfig(config);
    res.json({ ok: true, version: config.version });
  } catch (e) { res.status(404).json({ error: 'Not found or invalid: ' + String(e) }); }
});

app.get('/api/xml', requireAdmin, (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.type('xml').send(buildServiceList(base, config));
});

// SSRF guard: block private/loopback/link-local ranges (incl. cloud metadata 169.254.169.254)
function _isPrivateIp(ip) {
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  const l = ip.toLowerCase();
  if (l === '::1' || l === '::') return true;
  if (l.startsWith('fe80')) return true;
  if (l.startsWith('fc') || l.startsWith('fd')) return true;
  return false;
}

// Async: validates scheme AND that the host does not resolve to a private/internal address.
async function _requireSafeUrl(url, res) {
  let p;
  try { p = new URL(url); } catch { res.status(400).json({ error: 'Invalid URL' }); return false; }
  if (!['http:', 'https:'].includes(p.protocol)) { res.status(400).json({ error: 'Only http/https URLs are allowed' }); return false; }
  try {
    const host  = p.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map(a => a.address);
    if (!addrs.length || addrs.some(_isPrivateIp)) {
      res.status(400).json({ error: 'URL resolves to a disallowed (private/loopback) address' });
      return false;
    }
  } catch { res.status(400).json({ error: 'Could not resolve host' }); return false; }
  return true;
}

app.get('/api/test-url', requireAdmin, rateLimit('proxy', 20, 60000), async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  if (!(await _requireSafeUrl(url, res))) return;
  try {
    const r = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'DVBIAdmin/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    res.json({ ok: r.ok, status: r.status, contentType: r.headers.get('content-type') || '' });
  } catch {
    try {
      const r2 = await fetch(url, {
        headers: { 'User-Agent': 'DVBIAdmin/1.0', Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(8000),
      });
      res.json({ ok: r2.ok || r2.status === 206, status: r2.status });
    } catch (e2) { res.json({ ok: false, status: 0, error: String(e2) }); }
  }
});

const MAX_XML_BYTES = 10 * 1024 * 1024; // 10 MB

app.get('/api/fetch-xml', requireAdmin, rateLimit('proxy', 20, 60000), async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  if (!(await _requireSafeUrl(url, res))) return;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'DVBIAdmin/1.0', Accept: 'application/xml,*/*' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return res.status(r.status).json({ error: `Upstream HTTP ${r.status}` });
    const cl = parseInt(r.headers.get('content-length') || '0', 10);
    if (cl > MAX_XML_BYTES) return res.status(413).json({ error: 'Response too large (> 10 MB)' });
    const text = await r.text();
    if (text.length > MAX_XML_BYTES) return res.status(413).json({ error: 'Response too large (> 10 MB)' });
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(text);
  } catch (e) { res.status(502).json({ error: String(e) }); }
});

app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', version: config.version, services: config.services.length }));

// Optional native HTTPS via HTTPS_KEY_PATH/HTTPS_CERT_PATH (PEM file paths). Falls back to plain
// HTTP if unset — the recommended production pattern is TLS termination at a reverse proxy
// (see DEPLOYMENT.md), but native HTTPS is supported for standalone deployments.
function startServer() {
  const keyPath = process.env.HTTPS_KEY_PATH, certPath = process.env.HTTPS_CERT_PATH;
  if (keyPath && certPath) {
    try {
      const key = fs.readFileSync(keyPath), cert = fs.readFileSync(certPath);
      return https.createServer({ key, cert }, app).listen(PORT, () => {
        logger.info('DVB-I Application Provider and Admin Portal listening (https)', { port: PORT });
        console.log(`DVB-I Application Provider and Admin Portal  →  https://localhost:${PORT}`);
      });
    } catch (e) {
      logger.error('Failed to load HTTPS cert/key, falling back to HTTP', { error: String(e.message || e) });
    }
  }
  return http.createServer(app).listen(PORT, () => {
    logger.info('DVB-I Application Provider and Admin Portal listening (http)', { port: PORT });
    console.log(`DVB-I Application Provider and Admin Portal  →  http://localhost:${PORT}`);
    console.log(`Service list    →  http://localhost:${PORT}/service-list.xml`);
  });
}

// Only listen when run directly; when required (e.g. by the XSD test) just export the builders.
if (require.main === module) startServer();

module.exports = { app, startServer, buildServiceList, buildSchedule, msDur, cgsidProblem, mbmsLocatorProblem };
