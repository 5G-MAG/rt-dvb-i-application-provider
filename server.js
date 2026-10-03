/*
License: 5G-MAG Public License (v1.0)
Authors: Jordi J. Gimenez (5G-MAG)
Copyright: (C) 2026 5G-MAG Association

For full license terms please see the LICENSE file distributed with this
program. If this file is missing then the license can be retrieved from
https://www.5g-mag.com/license
*/
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
// in the editor, and the ContentGuideSourceRef values pointing at it inherit the problem.
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

// RFC 3986 character classes for the parts of the MBMS URL (clauses 2.1 to 2.3, 3.2 and 3.3). The
// prefix "shall not contain the character "&"" (TS 26.347 clause 8.2.2), so "&" is taken out of
// sub-delims there; mid-value is TS 26.347's own uchar set.
const MBMS_URI = (() => {
  const U = "A-Za-z0-9\\-._~";                 // unreserved
  const PCT = "%[0-9A-Fa-f]{2}";               // pct-encoded
  const SUB = "!$'()*+,;=";                    // sub-delims without "&"
  const userinfo = `(?:[${U}${SUB}:]|${PCT})*`;
  const regName = `(?:[${U}${SUB}]|${PCT})+`;
  // RFC 3986 clause 3.2.2: IP-literal = "[" ( IPv6address / IPvFuture ) "]", with IPv6address
  // written out as its nine alternatives, ls32, h16, IPv4address and dec-octet as defined there.
  // The same clause reads of IPvFuture 'an IP-literal that starts with "v" (case-insensitive)'.
  const decOctet = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)";
  const ipv4 = `(?:${decOctet}\\.){3}${decOctet}`;
  const h16 = "[0-9A-Fa-f]{1,4}";
  const ls32 = `(?:${h16}:${h16}|${ipv4})`;
  const pre = n => `(?:(?:${h16}:){0,${n}}${h16})?`;   // [ *n( h16 ":" ) h16 ]
  const ipv6 = '(?:' + [
    `(?:${h16}:){6}${ls32}`,
    `::(?:${h16}:){5}${ls32}`,
    `${pre(0)}::(?:${h16}:){4}${ls32}`,
    `${pre(1)}::(?:${h16}:){3}${ls32}`,
    `${pre(2)}::(?:${h16}:){2}${ls32}`,
    `${pre(3)}::${h16}:${ls32}`,
    `${pre(4)}::${ls32}`,
    `${pre(5)}::${h16}`,
    `${pre(6)}::`,
  ].join('|') + ')';
  const ipvFuture = `[vV][0-9A-Fa-f]+\\.[${U}${SUB}:]+`;
  const ipLiteral = `\\[(?:${ipv6}|${ipvFuture})\\]`;
  const host = `(?:${ipLiteral}|${ipv4}|${regName})`;
  const authority = `(?:${userinfo}@)?${host}(?::\\d*)?`;
  const pathAbempty = `(?:/(?:[${U}${SUB}:@]|${PCT})*)*`;
  const midValue = `(?:[${U};?:@=+$,/]|${PCT})+`;
  const resourceURI = `[A-Za-z][A-Za-z0-9+.\\-]*:(?:[${U}:/?#\\[\\]@!$&'()*+,;=]|${PCT})*`;
  return {
    prefix: new RegExp(`^mbms://(${authority})${pathAbempty}$`),
    mid: new RegExp(`^[A-Za-z][A-Za-z0-9]*=${midValue}$`),
    label: new RegExp(`^${resourceURI}$`),
  };
})();

function mbmsLocatorProblem(url) {
  const u = String(url || '');
  if (!u.startsWith('mbms://')) return `"${u}" is not an MBMS URL: it must start with mbms:// (TS 26.347 clause 8.2.2).`;
  const at = u.indexOf('&label=');
  const head = at < 0 ? u : u.slice(0, at);
  const label = at < 0 ? null : u.slice(at + '&label='.length);
  const [prefix, ...mid] = head.split('&');
  const m = MBMS_URI.prefix.exec(prefix);
  if (!m) return `"${u}" is not an MBMS URL: after mbms:// it needs an RFC 3986 authority and an optional path, with no "&", query or fragment before any &label= (TS 26.347 clause 8.2.2).`;
  const authorityHost = m[1].replace(/^[^@]*@/, '').replace(/:\d*$/, '');
  if (mid.length && authorityHost !== MBMS_ROM_AUTHORITY) return `"${u}" carries &name=value pairs, which TS 26.347 clause 8.2.2 says shall not be present outside the Receive-only Mode form on mbms://${MBMS_ROM_AUTHORITY} (clause 8.2.4).`;
  if (mid.some(p => !MBMS_URI.mid.test(p))) return `"${u}" has a mid-part that is not &name=value (TS 26.347 clause 8.2.2).`;
  if (label !== null && !MBMS_URI.label.test(label)) return `"${u}": the &label= suffix must be a URI (TS 26.347 clause 8.2.2, RFC 3986 clause 3).`;
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

// Clause 5.2.10: "Each such element shall only be repeated once per language code." The service
// names are the one multilingual element configured per language, so each row needs its own code.
function languagesProblem(cfg) {
  for (const [i, s] of (cfg.services || []).entries()) {
    const seen = new Set();
    for (const l of ((s && s.languages) || [])) {
      const code = String((l && l.lang) || '').trim();
      if (!code) return `services[${i}]: a service name has no language code (TS 103 770 clause 5.2.10).`;
      if (seen.has(code)) {
        return `services[${i}]: language code "${code}" is used for more than one service name; ` +
               `each element shall only be repeated once per language code (TS 103 770 clause 5.2.10).`;
      }
      seen.add(code);
    }
    if (s && s.audioLanguages != null &&
        (!Array.isArray(s.audioLanguages) || s.audioLanguages.some(l => typeof l !== 'string' || !l.trim()))) {
      return `services[${i}].audioLanguages must be a list of language codes.`;
    }
  }
  return null;
}

// The country codes of the list's regions (table 38, CountryRegionType@countryCodes), typed
// tva:ISO-3166-List. Only the format is checked here; whether a code is assigned in ISO 3166 is not.
function listCountry(cfg) {
  const cc = String(cfg.targetCountry || '').trim().toUpperCase();
  return /^[A-Z]{3}(,[A-Z]{3})*$/.test(cc) ? cc : null;
}

function countryProblem(cfg) {
  const regional = (cfg.services || []).some(s => s && s.enabled !== false && s.targetRegion);
  if (regional && !listCountry(cfg)) {
    return 'Services have target regions, so the region list needs the countries that make up its ' +
           'regions (TS 103 770 clause 5.6.2.1, table 38, @countryCodes): set the list\'s target ' +
           'country to ISO 3166 alpha-3 codes, for example GBR.';
  }
  return null;
}

// Table 42 (clause 6.10.5.2): Title "The character length shall not exceed 80 characters for
// either."; a medium Synopsis "shall not exceed 250 characters". Each programme's title and
// description are written as those, so longer ones are refused rather than cut.
function guideProblem(cfg) {
  const chars = v => [...String(v == null ? '' : v)].length;
  for (const [i, s] of (cfg.services || []).entries()) {
    for (const [j, p] of ((s && s.epgPrograms) || []).entries()) {
      if (chars(p && p.title) > 80) {
        return `services[${i}].epgPrograms[${j}]: the title is longer than 80 characters (TS 103 770 clause 6.10.5.2, table 42).`;
      }
      if (chars(p && p.desc) > 250) {
        return `services[${i}].epgPrograms[${j}]: the description is longer than 250 characters, the limit of a medium ` +
               `synopsis (TS 103 770 clause 6.10.5.2, table 42).`;
      }
    }
  }
  return null;
}

// ── Catch-up player: the content deep-linked XML AIT ─────────────────────────
//
// TS 103 770 V1.2.1 clause 6.10.8.2, table 52, row ProgramURL: "A URL location of a content
// deep-linked XML AIT for the on-demand programme. The XML AIT shall be used to launch the on-demand
// player." and "The @contentType attribute of the element shall carry the value
// application/vnd.dvb.ait+xml." The player is the operator's application, so every value the XML
// AIT says about it is taken from cfg.catchupPlayer as entered; none is defaulted here. The checks
// below refuse only what a clause or the XML AIT schema (mis_xmlait.xsd) does not allow.
const AIT_MEDIA_TYPE = 'application/vnd.dvb.ait+xml';
// Clause 5.2.4.1: "XML AIT files shall also signal one of the following MIME type values to
// represent each application type within the mhp:ApplicationDescription.mhp:type.mhp:OtherApp element"
const HBBTV_APP_TYPE = 'application/vnd.hbbtv.xhtml+xml';
const AIT_APP_TYPES = [HBBTV_APP_TYPE, 'text/html', 'application/xhtml+xml'];
// mis_xmlait.xsd enumerations ApplicationControlCode and VisibilityDescriptor. The trailing space
// in "NOT_VISIBLE_USERS " is in the schema (and in ETSI TS 102 809 V1.3.1 clause 5.4.4.5).
const AIT_CONTROL_CODES = ['AUTOSTART', 'PRESENT', 'DESTROY', 'KILL', 'PREFETCH', 'REMOTE', 'DISABLED', 'PLAYBACK_AUTOSTART'];
const AIT_VISIBILITY = ['NOT_VISIBLE_ALL', 'NOT_VISIBLE_USERS ', 'VISIBLE_ALL'];
// Clause 5.2.4.4.6: the client appends "regionID[]" and "lloc"; clause 5.2.4.3: "the Content
// Provider shall ensure that any included query parameters are distinct from the contextual
// parameters specified in clause 5.2.4.4.6."
const AIT_CONTEXT_PARAMS = ['regionID[]', 'lloc'];
// Clause 5.2.4.2: "The platform profile value shall be specified in the child elements of the
// mhp:mhpVersion element. This shall be as defined in clause 7.2.3.1, table 5 of ETSI TS 102 796 [21]."
// Reference [21] is undated, so its latest issue applies: ETSI TS 102 796 V1.8.1 (2026-09). Table 5,
// row "5.2.5 Platform profiles": the basic profile is 0x0000, and 0x0001 (A/V content download)
// and 0x0002 (PVR) "can be combined"; terminals "shall launch applications signalled with the
// following values for major, minor and micro", the versions listed here.
const AIT_PROFILES = [0x0000, 0x0001, 0x0002, 0x0003];
const AIT_PLATFORM_VERSIONS = ['1.1.1', '1.2.1', '1.3.1', '1.4.1', '1.5.1', '1.6.1', '1.7.1', '1.8.1'];
// ETSI TS 102 809 V1.3.1 clause 5.2.3.1: organisation_id "Values of zero shall not be encoded" and
// "the most significant 8 bits of the organisation_id shall be zero"; table 1 gives application_id
// 0x0001 to 0x9fff to unsigned, signed and privileged applications, reserves 0xa000 to 0xfffd, and
// 0xfffe and 0xffff "shall not be used to identify an application".
const AIT_ORG_ID_MAX = 0xffffff;
const AIT_APP_ID_MAX = 0x9fff;
// ETSI TS 102 796 V1.8.1 clause 7.2.3.2, table 7 note 2: "Content Providers shall ensure the length
// of the concatenation of URLBase and applicationLocation is 2 048 characters or less."
const HBBTV_LAUNCH_URL_MAX = 2048;

const isHex = (v, n) => typeof v === 'string' && new RegExp(`^[0-9a-fA-F]{1,${n}}$`).test(v);
const queryNames = loc => { try { return [...new URL(loc, 'http://h/').searchParams.keys()]; } catch (_) { return null; } };

// Why the configured catch-up player cannot be written as an XML AIT, or null when it can.
function catchupPlayerProblem(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'the catch-up player must be an object.';
  const hbbtv = p.type === HBBTV_APP_TYPE;
  const id = v => (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) ? Number(v) : NaN;
  if (typeof p.domainName !== 'string' || !/^\S*\.\S*$/.test(p.domainName)) {
    return 'domainName (ApplicationDiscovery@DomainName) is required and must be a domain name containing a "." (mis_xmlait.xsd, OfferingBase).';
  }
  if (typeof p.appName !== 'string' || !p.appName.trim()) return 'appName is required (mis_xmlait.xsd, Application/appName).';
  if (typeof p.appNameLang !== 'string' || !/^[a-z]{3}$/.test(p.appNameLang)) {
    return 'appNameLang must be a three-letter ISO 639-2 code such as "eng" (mis_xmlait.xsd, appName@Language).';
  }
  const orgId = id(p.orgId), appId = id(p.appId);
  if (!(orgId >= 1 && orgId <= AIT_ORG_ID_MAX)) {
    return 'orgId must be the organisation_id registered with DVB, from 1 to 16777215 (ETSI TS 102 809 clause 5.2.3.1).';
  }
  if (!(appId >= 1 && appId <= AIT_APP_ID_MAX)) {
    return 'appId must be from 1 to 40959 (0x9fff): 0 shall not be used, 0xa000 to 0xfffd are reserved and 0xfffe and 0xffff are wildcards (ETSI TS 102 809 clause 5.2.3.1, table 1).';
  }
  if (!AIT_APP_TYPES.includes(p.type)) {
    return `type must be one of ${AIT_APP_TYPES.join(', ')} (TS 103 770 clause 5.2.4.1).`;
  }
  if (!AIT_CONTROL_CODES.includes(p.controlCode)) return `controlCode must be one of ${AIT_CONTROL_CODES.join(', ')} (mis_xmlait.xsd).`;
  if (p.visibility != null && !AIT_VISIBILITY.includes(p.visibility)) return 'visibility is not a VisibilityDescriptor value (mis_xmlait.xsd).';
  if (p.serviceBound != null && typeof p.serviceBound !== 'boolean') return 'serviceBound must be true or false.';
  if (hbbtv) {
    // ETSI TS 102 796 V1.8.1 clause 7.2.3.2, table 7, column "Requirement on XML AIT file".
    if (p.controlCode !== 'AUTOSTART') return 'an HbbTV application\'s controlCode "Shall be AUTOSTART." (ETSI TS 102 796 clause 7.2.3.2, table 7).';
    if (p.visibility !== 'VISIBLE_ALL') return 'an HbbTV application\'s visibility "Shall be VISIBLE_ALL." (ETSI TS 102 796 clause 7.2.3.2, table 7).';
    if (p.serviceBound !== false) return 'an HbbTV application\'s serviceBound "Shall be false." (ETSI TS 102 796 clause 7.2.3.2, table 7).';
  }
  if (!isHex(p.priority, 2)) return 'priority must be one or two hexadecimal digits (mis_xmlait.xsd, Hexadecimal8bit).';
  if (typeof p.version !== 'string' || !/^[0-9a-fA-F]{2}$/.test(p.version)) {
    return 'version must be two hexadecimal digits, for example 01 (mis_xmlait.xsd, ipi:Version).';
  }
  if (!isHex(p.profile, 4) || !['versionMajor', 'versionMinor', 'versionMicro'].every(k => isHex(p[k], 2))) {
    return 'profile, versionMajor, versionMinor and versionMicro are required, in hexadecimal (TS 103 770 clause 5.2.4.2, mis_xmlait.xsd MhpVersion).';
  }
  if (!AIT_PROFILES.includes(parseInt(p.profile, 16))) {
    return 'profile must be 0 (basic), 1, 2 or 3: the profiles ETSI TS 102 796 clause 7.2.3.1, table 5 defines (TS 103 770 clause 5.2.4.2).';
  }
  const ver = ['versionMajor', 'versionMinor', 'versionMicro'].map(k => parseInt(p[k], 16)).join('.');
  if (!AIT_PLATFORM_VERSIONS.includes(ver)) {
    return `platform version ${ver} is not one ETSI TS 102 796 clause 7.2.3.1, table 5 lists (${AIT_PLATFORM_VERSIONS.join(', ')}); ` +
           'the client "shall ignore applications listed with other values" (TS 103 770 clause 5.2.4.2).';
  }
  let base;
  try { base = new URL(p.urlBase); } catch (_) { base = null; }
  if (!base || (base.protocol !== 'https:' && base.protocol !== 'http:') || typeof p.urlBase !== 'string') {
    return 'urlBase must be an absolute http or https URL (mis_xmlait.xsd, HTTPTransportType/URLBase).';
  }
  if (hbbtv && !p.urlBase.endsWith('/')) {
    return 'an HbbTV application\'s URLBase "shall be a URL ending with a slash" (ETSI TS 102 796 clause 7.2.3.2, table 7).';
  }
  if (p.location != null && typeof p.location !== 'string') return 'location must be text.';
  const loc = p.location || '';
  const names = queryNames(loc);
  if (/\s|#/.test(loc) || !names) return 'location must be a relative URL without spaces or a fragment.';
  if (typeof p.contentParameter !== 'string' || !p.contentParameter.trim()) {
    return 'contentParameter is required: the name of the query parameter that gives the player the programme\'s catch-up URL.';
  }
  for (const n of [...names, p.contentParameter]) {
    if (AIT_CONTEXT_PARAMS.includes(n)) {
      return `the query parameter "${n}" is a contextual parameter the client appends; the Content Provider "shall ensure that any ` +
             'included query parameters are distinct from the contextual parameters" (TS 103 770 clause 5.2.4.3).';
    }
  }
  return null;
}

// applicationLocation of the deep link: the configured location with the programme's catch-up URL
// as the configured query parameter. Clause 5.2.4.3: "Within the XML AIT the concatenation of
// URLBase and applicationLocation shall form a URL specifying an application launch location that
// allows launching of a player application directly."
function aitLocation(p, catchupUrl) {
  const loc = p.location || '';
  const sep = !loc.includes('?') ? '?' : (loc.endsWith('?') || loc.endsWith('&') ? '' : '&');
  return `${loc}${sep}${encodeURIComponent(p.contentParameter)}=${encodeURIComponent(catchupUrl)}`;
}

// Why programme ev cannot be offered on demand, or null when it can.
function deepLinkProblem(cfg, ev) {
  if (!ev.catchupUrl) return 'it has no catch-up URL.';
  if (cfg.catchupPlayer == null) return 'no catch-up player is configured, so there is no XML AIT for ProgramURL (TS 103 770 clause 6.10.8.2, table 52).';
  const pp = catchupPlayerProblem(cfg.catchupPlayer);
  if (pp) return `catchupPlayer: ${pp}`;
  const p = cfg.catchupPlayer;
  if (p.type === HBBTV_APP_TYPE && [...(p.urlBase + aitLocation(p, ev.catchupUrl))].length > HBBTV_LAUNCH_URL_MAX) {
    return 'URLBase and applicationLocation together are longer than 2 048 characters (ETSI TS 102 796 clause 7.2.3.2, table 7, note 2).';
  }
  return null;
}

// Refused on save: a catch-up URL is a claim that the programme is on demand, which needs an
// OnDemandProgram (clause 6.5.4.1: "Where a ScheduleEvent in the ProgramLocation table is also
// available as an on-demand item then an OnDemandProgram element shall also be returned"), whose
// ProgramURL is mandatory and has to be the XML AIT (table 52).
function catchupProblem(cfg) {
  if (cfg.catchupPlayer != null) {
    const pp = catchupPlayerProblem(cfg.catchupPlayer);
    if (pp) return `catchupPlayer: ${pp}`;
  }
  for (const [i, s] of (cfg.services || []).entries()) {
    for (const [j, ev] of ((s && s.epgPrograms) || []).entries()) {
      if (!ev || !ev.catchupUrl) continue;
      const why = deepLinkProblem(cfg, ev);
      if (why) return `services[${i}].epgPrograms[${j}] has a catch-up URL, but ${why}`;
    }
  }
  return null;
}

function publishProblem(cfg) {
  return uidProblem(cfg) || priorityProblem(cfg) || languagesProblem(cfg) || countryProblem(cfg) ||
         guideProblem(cfg) || catchupProblem(cfg);
}

// Clause 5.2.8.2.1, table 8: the permissible image_variant values. "The list of image_variant
// query parameters listed in table 8 shall be used by ALL endpoints to validate image_variant
// query parameters."
const IMAGE_VARIANTS = new Set([
  '16x9_colour', 'square_colour', '4x3_colour', '16x9_white', 'square_white',
  '16x9_colour_light', 'square_colour_light', '16x9_colour_dark', 'square_colour_dark',
]);

// Server-side Region Selection, regionID method (clause 5.6.4.4: <ServiceList_URL>?region=<regionID>).
// Returns null when the request asks for none, otherwise the table 38a @responseStatus and, when
// the region is one this list defines, the region to tailor to.
function srsRequest(query, cfg) {
  if (!('region' in query)) return null;
  const r = query.region;
  if (typeof r !== 'string' || !r) return { status: 'ERROR_INVALID_REQUEST' };
  const known = (cfg.services || []).some(s => s && s.enabled !== false && s.targetRegion === r);
  return known ? { status: 'OK', region: r } : { status: 'ERROR_INVALID_REGION_ID' };
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
// Clause 5.2.8.2.1: "If any other value is provided, then an HTTP 400 Bad Request error shall be
// returned." Checked before every route, static files included, since the clause names ALL endpoints.
app.use((req, res, next) => {
  if (!('image_variant' in req.query)) return next();
  const v = req.query.image_variant;
  if (typeof v === 'string' && IMAGE_VARIANTS.has(v)) return next();
  return res.status(400).json({ error: 'image_variant is not a value of TS 103 770 table 8' });
});
// Uploaded logos are operator-supplied files served from this origin. The upload takes PNG and JPEG
// only, but the directory serves whatever file is in it, and an SVG there carrying a <script> would
// execute here if a browser navigated to it directly. It cannot when it is only ever an <img> source, which is how the editor and the
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

// An uploaded logo is the service's only logo, and clause 5.2.6.2 requires at least one to be
// image/jpeg or image/png, so those are the types accepted.
const LOGO_EXTS = new Set(['.png', '.jpg', '.jpeg']);
const logoUpload = multer({
  storage: logoStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (/^image\/(png|jpeg)$/.test(file.mimetype) && LOGO_EXTS.has(ext)) cb(null, true);
    else cb(new Error('PNG or JPEG images only (TS 103 770 clause 5.2.6.2)'));
  },
});

app.post('/api/logos/upload/:id', requireAdmin, rateLimit('mutate', 30, 60000), (req, res, next) => {
  if (!/^[a-z0-9-]+$/i.test(req.params.id)) return res.status(400).json({ error: 'Invalid service ID' });
  next();
}, (req, res, next) => logoUpload.single('logo')(req, res, err =>
  err ? res.status(400).json({ error: err.message }) : next()
), (req, res) => {
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

// The image Media Type of a logo URL: from the media type of an RFC 2397 data URL, otherwise from
// the file extension. null when neither says, since a type that is not known cannot be signalled.
function detectMimeType(url) {
  const data = /^data:([^;,]+)/i.exec(url || '');
  if (data) return data[1].toLowerCase();
  const ext = (url || '').split('?')[0].split('.').pop().toLowerCase();
  const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
  return map[ext] || null;
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
  // Server-side Region Selection by region identifier (clause 5.6.4.4): a list tailored to one
  // region holds that region's services and those that target no region. opts.srs comes from
  // srsRequest(); on an error status the list is the untailored one.
  const srs = opts.srs || null;
  if (srs && srs.region) enabled = enabled.filter(s => !s.targetRegion || s.targetRegion === srs.region);

  // LCN tables. TS 103 770 V1.2.1 clause 5.5.12: "Therefore, there shall be only one applicable
  // LCNTable in the Service List:" in total, or one per unique TargetRegion. Table 25 makes a table
  // without TargetRegion "applicable anywhere", so once any table names a region there can be no
  // such table: each region's table also numbers the services that target no region.
  const regionLCNMap = {};
  const globalLCNEntries = [];
  for (const s of enabled) {
    if (s.targetRegion && !regionLCNMap[s.targetRegion]) regionLCNMap[s.targetRegion] = [];
  }
  for (const s of enabled) {
    if (s.lcn == null) continue;
    const entry = { lcn: s.lcn, uid: s.uid };
    if (s.targetRegion) {
      regionLCNMap[s.targetRegion].push(entry);
    } else if (Object.keys(regionLCNMap).length) {
      for (const entries of Object.values(regionLCNMap)) entries.push(entry);
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

  // RegionList: RegionListType requires @version; Region is CountryRegionType. Table 38 defines
  // @countryCodes as "The list of countries that make up the region", so it is the list's
  // configured country (see countryProblem), never derived from the region identifier.
  const regions = [...new Set(enabled.filter(s => s.targetRegion).map(s => s.targetRegion))];
  const listCC  = listCountry(cfg);
  const regionList = regions.length ? `
  <RegionList version="${xe(version)}">
${regions.map(r => {
    const ccAttr = listCC ? ` countryCodes="${xe(listCC)}"` : '';
    return `    <Region regionID="${xe(r)}"${ccAttr} xml:lang="en">
      <RegionName>${xe(r)}</RegionName>
    </Region>`;
  }).join('\n')}
  </RegionList>` : '';

  // LanguageList: table 14 defines it as "A list of audio languages related to the Service List's
  // services.", so it is built from each service's configured audio languages and left out when
  // none is configured.
  const langSet = new Set();
  for (const s of enabled) for (const l of (s.audioLanguages || [])) langSet.add(l);
  const languageListEl = langSet.size ? `
  <LanguageList>
${[...langSet].map(l => `    <Language>${xe(l)}</Language>`).join('\n')}
  </LanguageList>` : '';

  const serviceBlocks = enabled.map(s => {
    // logoUrl is either absolute (what the editor's "Logo Image URL" field invites) or a path on
    // this server (what the logo upload stores, e.g. /logos/uploaded/x.png). Only the relative form
    // is resolved against base: prefixing base onto an absolute URL produced a malformed MediaUri
    // of the form "http://hosthttp://host/...", which is not a valid xs:anyURI and fails schema
    // validation, while still looking plausible in the rendered XML.
    const logoAbs  = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s.logoUrl || '') || (s.logoUrl || '').startsWith('//');
    const logoUri  = logoAbs ? xe(s.logoUrl) : `${xe(base)}${xe(s.logoUrl || '')}`;
    const logoType = s.logoUrl ? detectMimeType(s.logoUrl) : null;

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
        // Never published with a locator that is not an MBMS URL. Saving refuses one; a list loaded
        // at start-up or edited by hand can still hold one, and that instance is left out (the
        // start-up log names it) so the server keeps running and the editor can correct it.
        if (mbmsLocatorProblem(inst.url)) return '';
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

    // Table 15, row ProviderName: "This element should include an @xml:lang attribute to identify
    // the language being used." The provider name is not configured per language, so it is in the
    // list's own language.
    const providerEl = `\n    <ProviderName xml:lang="${xe(cfg.listLang || 'en')}">${xe(s.provider)}</ProviderName>`;

    // Logo RelatedMaterial — HowRelated and MediaLocator are in TVA namespace (TS 103 770 §6.10 / TS 102 822)
    // Clause 5.2.6.2: "At least one service logo shall be provided with the Media Type image/jpeg or
    // image/png for compatibility purposes". A service has one logo, so it is signalled only when it
    // is one of those two; the generated placeholder at /logos/:id is SVG and is not signalled.
    // No image variants exist here, so a request naming one gets no logo (clause 5.2.8.2.1).
    const logoEl = !opts.imageVariant && (logoType === 'image/jpeg' || logoType === 'image/png') ? `
    <RelatedMaterial>
      <tva:HowRelated href="urn:dvb:metadata:cs:HowRelatedCS:2021:1001.2"/>
      <tva:MediaLocator>
        <tva:MediaUri contentType="${logoType}">${logoUri}</tva:MediaUri>
      </tva:MediaLocator>
    </RelatedMaterial>` : '';

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

    // Clause 6.1: "Individual services within a service list reference one of the content guide
    // sources in the set by providing an ID in their ContentGuideSourceRef element that matches a
    // CGSID." No ContentGuideServiceRef is written, so clients query the guide with the
    // UniqueIdentifier, which is what /epg/schedule answers to.
    const cgsRef = s.customEpgUrl ? `epg-${s.id}` : cfg.epg.id;
    const cgsRefEl = `\n    <ContentGuideSourceRef>${xe(cgsRef)}</ContentGuideSourceRef>`;

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
    // RelatedMaterial* (logo, then linked app), ServiceGenre*, ServiceType*, ContentGuideSourceRef?, ParentalRating?
    return `
  <!-- ${xe(s.name)} -->
  <Service version="${xe(String(s.version || 1))}">
    <UniqueIdentifier>${xe(s.uid)}</UniqueIdentifier>${instanceBlocks}${regionEl}${nameEls}${providerEl}${logoEl}${linkedAppEl}${genreEl}${serviceTypeEl}${cgsRefEl}${pgEl}
  </Service>`;
  }).join('');

  // Clause 5.1.5: "When SubscriptionPackage elements are used in a Service List, a
  // SubscriptionPackageList element shall be defined (see clause 5.5.1 and 5.5.25), containing a
  // list of all unique SubscriptionPackage elements present in the LCN tables and/or Service
  // Instances within the Service List." Packages are only written on service instances.
  const packages = [...new Set(enabled
    .filter(s => s.subscriptionPackage && (s.instances || []).length)
    .map(s => s.subscriptionPackage))];
  const subPkgListEl = packages.length ? `
  <SubscriptionPackageList>
${packages.map(p => `    <SubscriptionPackage>${xe(p)}</SubscriptionPackage>`).join('\n')}
  </SubscriptionPackageList>` : '';

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
  version="${xe(version)}"${srs ? ` responseStatus="${xe(srs.status)}"` : ''} xml:lang="${xe(cfg.listLang || 'en')}">

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
        <dvbisd-t:URI>${xe(base)}/epg/program</dvbisd-t:URI>
      </ProgramInfoEndpoint>
    </ContentGuideSource>${perSvcCGS}
  </ContentGuideSourceList>
${serviceBlocks}${subPkgListEl}

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
  const base = publicBase(req);
  const targetCountry = req.query.TargetCountry || req.query.targetCountry || '';
  res.setHeader('Content-Type', SERVICE_LIST_MEDIA_TYPE);
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Last-Modified', lastSaved.toUTCString());
  const srs = srsRequest(req.query, config);
  const imageVariant = req.query.image_variant || null;
  res.send(buildServiceList(base, config, { targetCountry, srs, imageVariant }));
});

// ── EPG schedule ──────────────────────────────────────────────────────────────

function msDur(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (!h && !m && !sec) return 'PT0S';
  return `PT${h ? h + 'H' : ''}${m ? m + 'M' : ''}${sec ? sec + 'S' : ''}`;
}

// The generated schedule repeats a service's programmes back to back, the cycle starting at the
// Unix epoch, so the same instant always falls in the same event whichever window is asked for.
// Returns the events that overlap [fromMs, toMs).
function buildSchedule(progs, fromMs, toMs) {
  const items = (progs || []).map((p, progIdx) => ({ p, progIdx, durMs: Number(p.dur) * 60000 }))
    .filter(x => x.durMs > 0);
  const period = items.reduce((a, x) => a + x.durMs, 0);
  if (!period) return [];
  const out = [];
  let t = Math.floor(fromMs / period) * period;
  for (let i = 0; t < toMs; i = (i + 1) % items.length) {
    const { p, progIdx, durMs } = items[i];
    if (t + durMs > fromMs) out.push({ ...p, startMs: t, endMs: t + durMs, durMs, progIdx });
    t += durMs;
  }
  return out;
}

// One CRID per scheduled event, naming the service and the event's start, so that a pid taken from
// any response identifies one programme of one service (clause 6.6.2).
const CRID_BASE = 'crid://dvbi.example.com/2024';
const eventCrid = (svc, ev) => `${CRID_BASE}/prog/${encodeURIComponent(svc.id)}/${ev.startMs / 1000}`;

function eventFromCrid(cfg, crid) {
  const m = /^crid:\/\/dvbi\.example\.com\/2024\/prog\/([^/]+)\/(\d+)$/.exec(String(crid || ''));
  if (!m) return null;
  const svc = cfg.services.find(s => encodeURIComponent(s.id) === m[1]);
  if (!svc) return null;
  const startMs = Number(m[2]) * 1000;
  const ev = buildSchedule(svc.epgPrograms, startMs, startMs + 1).find(e => e.startMs === startMs);
  return ev ? { svc, ev } : null;
}

// Series groups for GroupInformation/MemberOf (TS 103 770 §6.10.17)
function seriesCridsOf(progs) {
  const seriesCrids = {};
  let idx = 0;
  for (const p of progs || []) {
    if (!p.seriesTitle) continue;
    const key = `${p.seriesTitle}::${p.seriesNumber || ''}`;
    if (!seriesCrids[key]) seriesCrids[key] = `crid://dvbi.example.com/2024/series/${++idx}`;
  }
  return seriesCrids;
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

function tvaMain(cfg, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<TVAMain xmlns="urn:tva:metadata:2024" xmlns:mpeg7="urn:tva:mpeg7:2008" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:tva="urn:tva:metadata:2024" xml:lang="${xe(cfg.listLang || 'en')}">
  <ProgramDescription>${body}
  </ProgramDescription>
</TVAMain>`;
}

// Clauses 6.5.2.2 and 6.6.2: an unknown Service ID or CRID is answered 200 with both tables empty.
const emptyTables = cfg => tvaMain(cfg, `
    <ProgramInformationTable/>
    <ProgramLocationTable/>`);

// ProgramInformation for one event (tables 41 and 42). memberOf adds the now/next structural
// group of clause 6.5.4.4; imageVariant drops the image, since no image variants exist here.
function programInformation(svc, ev, seriesCrids, { memberOf, imageVariant } = {}) {
  // Table 59, row MediaLocator: "At least one image shall be provided with the Media Type
  // image/jpeg or image/png", so a programme's single image is signalled only when it is one of those.
  const imgType = ev.image ? detectMimeType(ev.image) : null;
  const imgEl = !imageVariant && (imgType === 'image/jpeg' || imgType === 'image/png')
    ? `\n        <RelatedMaterial>
          <HowRelated href="urn:tva:metadata:cs:HowRelatedCS:2012:19"/>
          <MediaLocator><MediaUri contentType="${imgType}">${xe(ev.image)}</MediaUri></MediaLocator>
        </RelatedMaterial>` : '';
  const pgEl = ev.parentalAge != null && ev.parentalAge !== ''
    ? `\n        <ParentalGuidance><mpeg7:MinimumAge>${xe(String(ev.parentalAge))}</mpeg7:MinimumAge></ParentalGuidance>` : '';
  // In TVAMain the default namespace IS urn:tva:metadata:2024, so Name takes no prefix
  const genreEl = ev.genre
    ? `\n        <Genre href="${GENRE_CS[ev.genre] || GENRE_CS_DEFAULT}"><Name xml:lang="en">${xe(GENRE_LABEL[ev.genre] || ev.genre)}</Name></Genre>` : '';
  // MemberOf is a child of ProgramInformation (after BasicDescription), not of BasicDescription.
  // Table 41, row MemberOf: "The @xsi:type attribute shall always be set to MemberOfType."
  const members = [];
  if (memberOf) members.push(memberOf);
  if (ev.seriesTitle) {
    const crid = seriesCrids[`${ev.seriesTitle}::${ev.seriesNumber || ''}`];
    const index = (ev.episodeNumber != null && ev.episodeNumber !== '') ? ev.episodeNumber : null;
    members.push({ crid, index });
  }
  const memberEls = members.map(m =>
    `\n      <MemberOf xsi:type="MemberOfType" crid="${xe(m.crid)}"${m.index != null ? ` index="${xe(String(m.index))}"` : ''}/>`).join('');
  // Table 42: Title at most 80 characters; Synopsis "A minimum of one synopsis shall be provided and
  // this shall have the @length attribute of medium." Both lengths are enforced on save (guideProblem).
  // BasicContentDescriptionType sequence: Title, Synopsis, ..., Genre, ParentalGuidance, ..., RelatedMaterial.
  return `
    <ProgramInformation programId="${xe(eventCrid(svc, ev))}">
      <BasicDescription>
        <Title type="main">${xe(ev.title)}</Title>
        <Synopsis length="medium">${xe(ev.desc)}</Synopsis>${genreEl}${pgEl}${imgEl}
      </BasicDescription>${memberEls}
    </ProgramInformation>`;
}

function scheduleEvent(svc, ev, nowMs) {
  // Emit ActualStartTime/ActualEndTime for events that have started (A184r2 §4.5)
  // For generated schedules, actuals equal published values (no real broadcast delay to model)
  const actualEl = ev.startMs <= nowMs
    ? `\n        <ActualStartTime>${new Date(ev.startMs).toISOString()}</ActualStartTime>
        <ActualEndTime>${new Date(ev.endMs).toISOString()}</ActualEndTime>` : '';
  return `
      <ScheduleEvent>
        <Program crid="${xe(eventCrid(svc, ev))}"/>
        <PublishedStartTime>${new Date(ev.startMs).toISOString()}</PublishedStartTime>
        <PublishedDuration>${msDur(ev.durMs)}</PublishedDuration>${actualEl}
      </ScheduleEvent>`;
}

// URL of the content deep-linked XML AIT of one programme, served by /ait/program.aitx.
const aitUrl = (base, svc, ev) => `${base}/ait/program.aitx?pid=${encodeURIComponent(eventCrid(svc, ev))}`;

// Whether an event is written as on demand: it has a catch-up URL and the configured catch-up
// player gives it an XML AIT. A list loaded from disk is not checked on load, so one without a
// usable player gets no OnDemandProgram rather than a ProgramURL that is not an XML AIT.
const onDemand = (cfg, ev) => !!ev.catchupUrl && !deepLinkProblem(cfg, ev);

// OnDemandProgram for an event offered on demand (table 52). @serviceIDRef is the identifier the
// request used. ProgramURL is the programme's content deep-linked XML AIT (clause 5.2.4.3). Table 62:
// two availability Genre terms, from MediaAvailabilityCS (table 70) and
// FEPGAvailabilityCS (table 71), "The default values shall be media_unavailable and fepg_unavailable."
// Media is available between StartOfAvailability and EndOfAvailability; nothing here says an
// on-demand item is offered in the forwards EPG, so that one stays at its default.
function onDemandProgram(svc, ev, serviceIDRef, nowMs, base) {
  const startAvail = ev.startMs;
  const endAvail   = ev.endMs + 30 * 86400000;
  const media = nowMs >= startAvail && nowMs < endAvail ? 'media_available' : 'media_unavailable';
  return `
      <OnDemandProgram serviceIDRef="${xe(serviceIDRef)}">
        <Program crid="${xe(eventCrid(svc, ev))}"/>
        <ProgramURL contentType="${AIT_MEDIA_TYPE}">${xe(aitUrl(base, svc, ev))}</ProgramURL>
        <InstanceDescription>
          <Genre type="other" href="urn:fvc:metadata:cs:MediaAvailabilityCS:2014-07:${media}"/>
          <Genre type="other" href="urn:fvc:metadata:cs:FEPGAvailabilityCS:2014-10:fepg_unavailable"/>
        </InstanceDescription>
        <PublishedDuration>${msDur(ev.durMs)}</PublishedDuration>
        <StartOfAvailability>${new Date(startAvail).toISOString()}</StartOfAvailability>
        <EndOfAvailability>${new Date(endAvail).toISOString()}</EndOfAvailability>
        <DeliveryMode>streaming</DeliveryMode>
        <Free value="true"/>
      </OnDemandProgram>`;
}

// Clause 6.5.2.1 limits for start and end. The permitted times of day are those whose Unix time is
// a whole multiple of 10 800, so days are UTC days. Returns null for a request that breaks any of
// them: "a Content Guide Server shall return a 400 (Bad Request) HTTP response status".
const SLOT_S = 10800, DAY_S = 86400;
function scheduleWindow(query, nowMs) {
  const s = query.start, e = query.end;
  if (typeof s !== 'string' || typeof e !== 'string' || !/^\d+$/.test(s) || !/^\d+$/.test(e)) return null;
  const start = Number(s), end = Number(e);
  const midnight = Math.floor(nowMs / 1000 / DAY_S) * DAY_S;
  if (start % SLOT_S || end % SLOT_S) return null;
  if (end - start !== 21600 && end - start !== 43200) return null;
  if (start < midnight - 28 * DAY_S) return null;
  if (end > midnight + DAY_S + 28 * DAY_S) return null;
  return { fromMs: start * 1000, toMs: end * 1000 };
}

// Now/next groups (clause 6.5.4.4, table 64).
const NOW_NEXT = 'crid://dvb.org/metadata/schedules/now-next';
const NOW_NEXT_MAX = 10;

function nowNextResponse(cfg, svc, sid, kind, nowMs, imageVariant, base) {
  const maxDur = Math.max(...svc.epgPrograms.map(p => Number(p.dur) * 60000).filter(d => d > 0));
  const span = (NOW_NEXT_MAX + 1) * maxDur;
  const evs = buildSchedule(svc.epgPrograms, nowMs - span, nowMs + span);
  const cur = evs.findIndex(e => e.startMs <= nowMs && e.endMs > nowMs);
  if (cur < 0) return null;
  const later = kind === 'window' ? NOW_NEXT_MAX : 1;
  const earlier = kind === 'window' ? NOW_NEXT_MAX : 0;
  const picked = [
    ...evs.slice(Math.max(0, cur - earlier), cur).reverse().map((ev, i) => ({ ev, group: 'earlier', index: i + 1 })),
    { ev: evs[cur], group: 'now', index: 1 },
    ...evs.slice(cur + 1, cur + 1 + later).map((ev, i) => ({ ev, group: 'later', index: i + 1 })),
  ];
  const seriesCrids = seriesCridsOf(svc.epgPrograms);
  const inOrder = picked.slice().sort((a, b) => a.ev.startMs - b.ev.startMs);
  const progInfo = inOrder.map(x => programInformation(svc, x.ev, seriesCrids,
    { memberOf: { crid: `${NOW_NEXT}/${x.group}`, index: x.index }, imageVariant })).join('');
  const groups = ['earlier', 'now', 'later'].map(g => [g, picked.filter(x => x.group === g).length])
    .filter(([, n]) => n > 0)
    .map(([g, n]) => `
    <GroupInformation groupId="${NOW_NEXT}/${g}" ordered="true" numOfItems="${n}">
      <GroupType xsi:type="ProgramGroupTypeType" value="otherCollection"/>
      <BasicDescription/>
    </GroupInformation>`).join('');
  const ondemand = inOrder.filter(x => onDemand(cfg, x.ev)).map(x => onDemandProgram(svc, x.ev, sid, nowMs, base)).join('');
  return tvaMain(cfg, `
    <ProgramInformationTable>${progInfo}
    </ProgramInformationTable>
    <GroupInformationTable>${groups}
    </GroupInformationTable>
    <ProgramLocationTable>
      <Schedule serviceIDRef="${xe(sid)}" start="${new Date(inOrder[0].ev.startMs).toISOString()}" end="${new Date(inOrder[inOrder.length - 1].ev.endMs).toISOString()}">${inOrder.map(x => scheduleEvent(svc, x.ev, nowMs)).join('')}
      </Schedule>${ondemand}
    </ProgramLocationTable>`);
}

function timestampResponse(cfg, svc, sid, win, nowMs, imageVariant, base) {
  // Clause 6.5.2.1: only events with PublishedStartTime at or after start and before end.
  const evs = buildSchedule(svc.epgPrograms, win.fromMs, win.toMs).filter(e => e.startMs >= win.fromMs);
  if (!evs.length) return null;
  const seriesCrids = seriesCridsOf(svc.epgPrograms);
  const progInfo = evs.map(ev => programInformation(svc, ev, seriesCrids, { imageVariant })).join('');
  // GroupInformationType sequence: GroupType first, then BasicDescription. GroupType is an abstract
  // type, so it needs xsi:type naming the concrete ProgramGroupTypeType, which carries @value (not @href).
  const groupInfoItems = Object.entries(seriesCrids).map(([key, crid]) => {
    const sep    = key.lastIndexOf('::');
    const sTitle = key.slice(0, sep);
    const sNum   = key.slice(sep + 2);
    const seasonLabel = sNum ? ` (Season ${sNum})` : '';
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
  const ondemand = evs.filter(ev => onDemand(cfg, ev)).map(ev => onDemandProgram(svc, ev, sid, nowMs, base)).join('');
  return tvaMain(cfg, `
    <ProgramInformationTable>${progInfo}
    </ProgramInformationTable>${groupInfoTableEl}
    <ProgramLocationTable>
      <Schedule serviceIDRef="${xe(sid)}" start="${new Date(evs[0].startMs).toISOString()}" end="${new Date(evs[evs.length - 1].endMs).toISOString()}">${evs.map(ev => scheduleEvent(svc, ev, nowMs)).join('')}
      </Schedule>${ondemand}
    </ProgramLocationTable>`);
}

// ScheduleInfoEndpoint (clauses 6.5.2 and 6.5.3). sid is the service's UniqueIdentifier: the list
// carries no ContentGuideServiceRef, so that is the identifier clients query with.
function scheduleDocument(cfg, query, nowMs, base, nowNextDefault = null) {
  const sid = query.sid || query.serviceId;
  const imageVariant = query.image_variant || null;
  const kind = query.now_next || nowNextDefault;
  const nowNext = kind === 'true' || kind === 'window';
  const win = nowNext ? null : scheduleWindow(query, nowMs);
  if (!nowNext && !win) return { status: 400, xml: emptyTVAMain(cfg) };
  const svc = typeof sid === 'string' ? cfg.services.find(s => s.uid === sid) : null;
  if (!svc) return { status: 200, xml: emptyTables(cfg) };
  // A service that exists but carries no programmes, or none in the window, is not an error and is
  // answered 200: per TS 103 770 V1.2.1 clause 4.3.3.4, a 404 from a ContentGuideSource API URL
  // makes the client re-acquire the whole Service List. Clause 6.5.4.1 asks for an empty Schedule
  // element here, which the attached TV-Anytime schema rejects (ScheduleEvent is required), so no
  // Schedule is written; the clause's two tables still are, empty.
  const body = svc.epgPrograms?.length
    ? (nowNext ? nowNextResponse(cfg, svc, sid, kind, nowMs, imageVariant, base)
               : timestampResponse(cfg, svc, sid, win, nowMs, imageVariant, base))
    : null;
  return { status: 200, xml: body || emptyTables(cfg) };
}

app.get('/epg/schedule', (req, res) => {
  const { status, xml } = scheduleDocument(config, req.query, Date.now(), publicBase(req));
  res.status(status).type('xml').send(xml);
});

// ── EPG now/next (TS 103 770 §6.5.3) ────────────────────────────────────────────────────

// Not an endpoint the service list signals: now/next is a request to the ScheduleInfoEndpoint
// (clause 6.5.3.1). Kept for direct callers, answered as now_next=true by default.
app.get('/epg/nownext', (req, res) => {
  const { status, xml } = scheduleDocument(config, req.query, Date.now(), publicBase(req), 'true');
  res.status(status).type('xml').send(xml);
});

// ── EPG programme information (TS 103 770 §6.6) ─────────────────────────────────────────

// ProgramInfoEndpoint: one programme by its CRID. Clause 6.6.2: "In the case where the CRID is not
// known to a Content Guide Server then a 200 (OK) HTTP response shall be returned but the
// ProgramInformationTable and ProgramLocationTable shall not contain any elements."
function programDocument(cfg, query, nowMs, base) {
  const found = typeof query.pid === 'string' ? eventFromCrid(cfg, query.pid) : null;
  if (!found) return emptyTables(cfg);
  const { svc, ev } = found;
  const pi = programInformation(svc, ev, seriesCridsOf(svc.epgPrograms), { imageVariant: query.image_variant || null });
  const od = onDemand(cfg, ev) ? onDemandProgram(svc, ev, svc.uid, nowMs, base) : '';
  return tvaMain(cfg, `
    <ProgramInformationTable>${pi}
    </ProgramInformationTable>
    <ProgramLocationTable>${od}
    </ProgramLocationTable>`);
}

app.get('/epg/program', (req, res) => res.type('xml').send(programDocument(config, req.query, Date.now(), publicBase(req))));

// ── Content deep-linked XML AIT (TS 103 770 §5.2.4.3) ──────────────────────────────────

// The XML AIT that launches the catch-up player at one programme, pid being the programme's CRID
// (the ProgramURL of its OnDemandProgram). Structure and element order are those of mis_xmlait.xsd;
// one Application, so orgId and appId are trivially the same for all (clause 5.2.4.3). Returns null
// when the programme is unknown or not offered on demand.
function deepLinkedAit(cfg, pid) {
  const found = typeof pid === 'string' ? eventFromCrid(cfg, pid) : null;
  if (!found || !onDemand(cfg, found.ev)) return null;
  const p = cfg.catchupPlayer;
  const opt = (name, v) => v == null ? '' : `\n          <mhp:${name}>${xe(String(v))}</mhp:${name}>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<mhp:ServiceDiscovery xmlns:mhp="urn:dvb:mhp:2009" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <mhp:ApplicationDiscovery DomainName="${xe(p.domainName)}">
    <mhp:ApplicationList>
      <mhp:Application>
        <mhp:appName Language="${xe(p.appNameLang)}">${xe(p.appName)}</mhp:appName>
        <mhp:applicationIdentifier>
          <mhp:orgId>${Number(p.orgId)}</mhp:orgId>
          <mhp:appId>${Number(p.appId)}</mhp:appId>
        </mhp:applicationIdentifier>
        <mhp:applicationDescriptor>
          <mhp:type>
            <mhp:OtherApp>${xe(p.type)}</mhp:OtherApp>
          </mhp:type>
          <mhp:controlCode>${xe(p.controlCode)}</mhp:controlCode>${opt('visibility', p.visibility)}${opt('serviceBound', p.serviceBound)}
          <mhp:priority>${xe(p.priority)}</mhp:priority>
          <mhp:version>${xe(p.version)}</mhp:version>
          <mhp:mhpVersion>
            <mhp:profile>${xe(p.profile)}</mhp:profile>
            <mhp:versionMajor>${xe(p.versionMajor)}</mhp:versionMajor>
            <mhp:versionMinor>${xe(p.versionMinor)}</mhp:versionMinor>
            <mhp:versionMicro>${xe(p.versionMicro)}</mhp:versionMicro>
          </mhp:mhpVersion>
        </mhp:applicationDescriptor>
        <mhp:applicationTransport xsi:type="mhp:HTTPTransportType">
          <mhp:URLBase>${xe(p.urlBase)}</mhp:URLBase>
        </mhp:applicationTransport>
        <mhp:applicationLocation>${xe(aitLocation(p, found.ev.catchupUrl))}</mhp:applicationLocation>
      </mhp:Application>
    </mhp:ApplicationList>
  </mhp:ApplicationDiscovery>
</mhp:ServiceDiscovery>`;
}

// Clause 5.2.4.1: "XML AIT files shall be delivered by Content Providers with the Content-Type header
// set to application/vnd.dvb.ait+xml." The client appends the contextual parameters of clause
// 5.2.4.4.6 (regionID[], lloc) to this URL; they are accepted and do not change the response.
// Clause 4.3.3.4: on a 404 from a "Content Provider XML AIT server the DVB-I client shall not retry
// the request and deem it to have failed", which is the answer for a programme not on demand.
app.get('/ait/program.aitx', (req, res) => {
  const xml = deepLinkedAit(config, req.query.pid);
  if (!xml) return res.status(404).type('text/plain').send('No on-demand programme with this pid');
  res.setHeader('Content-Type', AIT_MEDIA_TYPE);
  res.send(xml);
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
    const base = publicBase(req);
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
    const mbms = mbmsProblem(data);
    if (mbms) return res.status(400).json({ error: mbms });
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
  const base = publicBase(req);
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

// TS 103 770 V1.2.1 clause 7.3: "All HTTP transactions and connections between the DVB-I client and
// DVB-I metadata endpoints, specifically Service List Registries, Service List Servers, Content
// Guide Servers, described in the present document shall be performed using HTTP over TLS", with
// one exception, quoted in PRIVATE_SUBNET_EXCEPTION below.
//
// So the server serves HTTPS when HTTPS_KEY_PATH and HTTPS_CERT_PATH name a PEM key and
// certificate. Only one of them set, or a key or certificate that cannot be loaded, stops the
// server: it never falls back to plain HTTP when TLS was asked for. With neither set it serves
// plain HTTP and logs a warning that names the exception, which the server does not check.
// PLAIN_HTTP=behind-tls-proxy also serves plain HTTP, for a reverse proxy that terminates TLS, and
// writes the endpoint URLs in the list as https://, the scheme clients reach the proxy with.
// PLAIN_HTTP=private-subnet is accepted and means the same as leaving PLAIN_HTTP unset.
// The TLS versions are Node's defaults, which offer TLS 1.2 and 1.3 (clause 7.3: servers "shall
// support TLS version 1.2" and "should support TLS version 1.3").
const PRIVATE_SUBNET_EXCEPTION = 'For the specific case that a DVB-I client connects to a DVB-I metadata ' +
  'endpoint located on the same private subnet (see clause 3 of IETF RFC 1918 [27]), HTTP may be used without TLS.';
const PLAIN_HTTP_MODES = { 'private-subnet': 'http', 'behind-tls-proxy': 'https' };
let publicScheme = null;

// The scheme and host clients reach this server at, for the endpoint URLs written into the list.
function publicBase(req) {
  return `${publicScheme || req.protocol}://${req.get('host')}`;
}

function startServer(env = process.env, port = PORT) {
  const mode = env.PLAIN_HTTP || undefined;
  const keyPath = env.HTTPS_KEY_PATH, certPath = env.HTTPS_CERT_PATH;
  if (mode !== undefined && !PLAIN_HTTP_MODES[mode]) {
    throw new Error(`PLAIN_HTTP must be one of ${Object.keys(PLAIN_HTTP_MODES).join(', ')} (got "${mode}")`);
  }
  if (keyPath || certPath) {
    if (!keyPath || !certPath) throw new Error('HTTPS_KEY_PATH and HTTPS_CERT_PATH must be set together');
    if (mode !== undefined) throw new Error(`PLAIN_HTTP=${mode} cannot be combined with HTTPS_KEY_PATH and HTTPS_CERT_PATH`);
    // createServer parses the key and certificate, so one that cannot be read or parsed throws here.
    const server = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app);
    publicScheme = 'https';
    return server.listen(port, () => {
      logger.info('DVB-I Application Provider and Admin Portal listening (https)', { port });
      console.log(`DVB-I Application Provider and Admin Portal  →  https://localhost:${port}`);
    });
  }
  publicScheme = PLAIN_HTTP_MODES[mode || 'private-subnet'];
  if (mode === 'behind-tls-proxy') {
    logger.info('Serving plain HTTP behind a TLS-terminating proxy; endpoint URLs in the list are https://');
  } else {
    logger.warn('Serving plain HTTP without TLS. ETSI TS 103 770 V1.2.1 clause 7.3 requires HTTP over TLS ' +
      `except: "${PRIVATE_SUBNET_EXCEPTION}" The server does not check that clients are on the same private ` +
      'subnet. Set HTTPS_KEY_PATH and HTTPS_CERT_PATH to serve HTTPS.');
  }
  return http.createServer(app).listen(port, () => {
    logger.info('DVB-I Application Provider and Admin Portal listening (http)', { port, plainHttp: mode || 'default' });
    console.log(`DVB-I Application Provider and Admin Portal  →  http://localhost:${port}`);
    console.log(`Service list    →  http://localhost:${port}/service-list.xml`);
  });
}

// Only listen when run directly; when required (e.g. by the XSD test) just export the builders.
if (require.main === module) {
  try { startServer(); }
  catch (e) { logger.error('Not started', { error: String(e.message || e) }); process.exit(1); }
}

module.exports = {
  app, startServer, buildServiceList, buildSchedule, msDur, cgsidProblem, mbmsLocatorProblem,
  scheduleDocument, programDocument, deepLinkedAit, catchupProblem,
};
