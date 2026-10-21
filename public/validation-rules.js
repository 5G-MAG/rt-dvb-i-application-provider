// Rules shared by the editor's Validate and Compliance views, kept apart from index.html so that
// the unit tests can load exactly the code the browser runs (no DOM is needed here).
(function (root) {
  'use strict';

  // The local 5G delivery extension (schemas/dvbi-5g-ext-1.0.xsd). No DVB schema defines it, so a
  // list that carries it is outside the published schemas. test/xsd-validate.js reports such a
  // document as "NOT CONFORMANT GROUND" and uses the same two markers.
  const NS_DVBI_5G = 'urn:5g-mag:metadata:dvbi-5g:2026';

  function usesLocalExtension(xmlText) {
    const t = String(xmlText || '');
    return t.includes(NS_DVBI_5G) || t.includes('MBMSDeliveryParametersType');
  }

  // Scheme check for the URL of one delivery instance. Plain http(s) is what stream URLs are. An
  // mbms:// locator is accepted only on an instance of type "mbms", which is the one the 5G-MAG
  // extension emits as dvbi5g:ServiceLocator inside OtherDeliveryParameters; on any other instance
  // it is not a URL the schema or a client can use, so it is still rejected. Multicast instances
  // carry udp:// addresses and are not subject to this check, as before.
  function streamUrlOk(inst) {
    if (!inst || !inst.url || inst.type === 'multicast') return true;
    if (/^https?:\/\//i.test(inst.url)) return true;
    return inst.type === 'mbms' && /^mbms:\/\//i.test(inst.url);
  }

  // The Validate view's checks, as data: [{ ok, warn, label, detail }].
  function listChecks(config) {
    const svcs    = config.services || [];
    const enabled = svcs.filter(s => s.enabled !== false);
    const checks  = [];
    function chk(ok, warn, label, detail) {
      checks.push({ ok: ok === true, warn: warn === true, label, detail: detail || '' });
    }

    chk(!!config.listName, false, 'List name is set', config.listName ? `"${config.listName}"` : 'Required field is empty');
    chk(!!config.providerName, false, 'Provider name is set', config.providerName ? `"${config.providerName}"` : 'Required field is empty');
    chk(!!config.listId, false, 'Service List ID is set (§5.5.1 mandatory)', config.listId ? `"${config.listId}"` : 'Required — use a tag: URI, e.g. tag:example.com,2024:servicelist:1');
    chk(!!(config.epg && config.epg.id), false, 'EPG source ID is set', config.epg && config.epg.id ? `"${config.epg.id}"` : 'Required for ContentGuideSource');
    chk(enabled.length > 0, false, 'At least one enabled service', `${enabled.length} enabled, ${svcs.length - enabled.length} disabled`);

    const lcnNums = enabled.filter(s => s.lcn != null).map(s => s.lcn);
    const lcnDups = lcnNums.filter((v, i) => lcnNums.indexOf(v) !== i);
    chk(lcnDups.length === 0, false, 'LCN values are unique', lcnDups.length ? `Duplicate LCNs: ${[...new Set(lcnDups)].join(', ')}` : `${lcnNums.length} channel numbers assigned`);

    const uids    = enabled.map(s => s.uid).filter(Boolean);
    const uidDups = uids.filter((v, i) => uids.indexOf(v) !== i);
    chk(uidDups.length === 0, false, 'Unique identifiers (UIDs) are unique', uidDups.length ? `Duplicate UIDs: ${[...new Set(uidDups)].join(', ')}` : 'All UIDs unique');

    let noNameCount = 0, noInstanceCount = 0, badUrlCount = 0, drmNoSchemeCount = 0;
    for (const s of enabled) {
      if (!s.name) noNameCount++;
      if (!(s.instances && s.instances.length)) noInstanceCount++;
      for (const inst of (s.instances || [])) {
        if (!streamUrlOk(inst)) badUrlCount++;
        // Multi-DRM model: each entry in drmSystems must carry an encryptionScheme (§5.5.20).
        // Tolerate legacy single-protection data that predates the drmSystems array.
        const drms = inst.drmSystems && inst.drmSystems.length ? inst.drmSystems
          : (inst.protection && inst.protection !== 'none' ? [{ encryptionScheme: inst.encryptionScheme }] : []);
        if (drms.some(d => !d.encryptionScheme)) drmNoSchemeCount++;
      }
    }
    chk(noNameCount === 0, false, 'All services have a name', noNameCount ? `${noNameCount} service(s) missing a name` : 'All services named');
    chk(noInstanceCount === 0, false, 'All services have at least one stream', noInstanceCount ? `${noInstanceCount} service(s) have no delivery instances` : 'All services have streams');
    chk(badUrlCount === 0, false, 'All stream URLs use http(s)',
      badUrlCount ? `${badUrlCount} URL(s) are not http/https (an mbms:// locator is accepted only on a 5G / MBMS extension instance)` : 'All URLs valid scheme');
    chk(drmNoSchemeCount === 0, true, 'DRM instances have an encryption scheme (§5.5.20 mandatory)', drmNoSchemeCount ? `${drmNoSchemeCount} instance(s) missing encryptionScheme — defaults to cenc` : 'All DRM instances have encryptionScheme');
    return checks;
  }

  const api = { NS_DVBI_5G, usesLocalExtension, streamUrlOk, listChecks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DvbiRules = api;
})(typeof self !== 'undefined' ? self : this);
