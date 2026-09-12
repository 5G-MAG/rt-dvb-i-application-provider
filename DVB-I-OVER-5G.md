# DVB-I over 5G: what integration would require

## Summary

Carrying the DVB-I services this server publishes over a 5G system is blocked on a small, specific
piece of DVB signalling, and on very little else. That is the finding, and it is more encouraging
than the reference document suggests.

**The gap list everyone cites is three years out of date.** ETSI TR 103 972, the deployment
guidelines for DVB-I over 5G, lists fourteen gaps in its two gap clauses, five for 5G Broadcast and
nine for 5G Media Streaming. Each was checked against the newest published issue of the document
that owns it, not against every document the report cites:

| | Count |
|---|---|
| Closed | 7 |
| Addressed by restructuring, though not as proposed | 1 |
| Not a gap; the report itself says so | 1 |
| Open | 5 |

One of those was closed a *month before the report was published*. Five more have closed since,
three of them in a 3GPP document that did not exist in its current form when the report was written.

**The five that remain split into two groups.** Three are the same DVB-side problem: a DVB-I service
list has nowhere to put a 5G locator, whether for 5G Broadcast or for 5GMS access information. Two
are xMB provisioning details that would matter to an operator but block nothing.

**The asymmetry is the real story.** The 3GPP-derived documents have moved through two or three
releases since the versions the report assessed, and that is where six of the seven closures happened.
The DVB side has moved once: TS 103 770 was reissued in 2024-09, which closed one gap, and it did not
add any way to signal 5G delivery. What is holding this up is a service list extension: small, well
understood, and squarely in DVB's court.

**What is already specified is more than most people expect.** TS 103 770 clause 9.3 covers carriage
of DVB-I in an MBMS system normatively, including the service class identifiers, and it puts the
DVB-I client in the role of an MBMS-Aware Application invoking an MBMS Client. That is the same
split the 5G-MAG reference implementations already have.

**What could be built here today**: choosing and documenting a local delivery-signalling extension,
emitting it from this server, and publishing the service list itself over MBMS, for which the
service class is already defined. Teaching a receiver to drive an MBS client is the substantial
piece. The 5G Media Streaming path is blocked on work that is not ours.

Full reasoning, evidence and clause references follow.

An assessment of what it would take to carry the DVB-I services these repositories publish over a
5G system, rather than over unicast HTTP as the live demo does today.

Written 2026-09-08 against the documents named below. It is an engineering assessment, not a
statement of DVB or 3GPP positions, and it should be checked against those bodies before being
relied on for anything beyond planning.

## The documents

| Document | Status | What it gives us |
|---|---|---|
| ETSI TS 103 770 V1.2.1 (2024-09) | published standard | the DVB-I service list format, and clause 9.3, carriage in an MBMS system |
| ETSI TR 103 972 V1.1.1 (2023-07) | technical report, informative | "DVB-I service delivery over 5G Systems; Deployment Guidelines": architectures, call flows, and explicit lists of gaps |
| DVB A177r8 (draft TS 103 770 V1.3.1, June 2026) | draft | the successor to the published standard |

TR 103 972 is a **Technical Report**: deployment guidance, not a specification. Its value here is
that clauses 6.2.4 and 6.3.4 enumerate what was missing from the standards, which is precisely the
question. Being from 2023-07, it predates the published TS 103 770 V1.2.1 by more than a year, and
part of its gap list has since been closed. Which parts, below.

## What is already specified, and is more than most people expect

TS 103 770 V1.2.1 clause 9.3 covers carriage of DVB-I in an MBMS system normatively, and it fits
the component split these repositories already have.

**Service classes are defined.** Clause 9.3.1, table 106 gives three identifiers:
`urn:dvb:metadata:serviceClass:DVB-I_Service_List:1`, `...DVB-I_Content_Guide:1` and
`...DVB-I_Service_Instance:1`, for a service list document, content guide documents, and the media
assets of a service instance respectively. The clause requires that
`userServiceDescription@serviceClass` be present and carry the appropriate one.

This closes TR 103 972 clause 6.2.4's gap that "a service class filter for DVB-I services is needed
to be defined by DVB in order to select DVB-I services". It was open when the report was written
and is not open now.

**The client model matches what we have built.** Clause 9.3.3 puts the DVB-I client in the role of
an MBMS-Aware Application which invokes an MBMS Client: it starts the service announcement channel,
acquires the service list from an MBMS user service of the right class when it has no unicast
connection, and subscribes to notifications so it picks up new versions of those documents.

That is the same split as `rt-mbms-client` (the MBMS Client, holding the announcement channel and
the reception) and `rt-mbms-application` (the MBMS-aware application driving it over a local API). A
DVB-I receiver would occupy the second role. `rt-mbs-*`, note, is a different system: it implements
5G MBS User Services of 3GPP TS 26.502, which clause 9.3 does not mention in any spelling. The
procedure below is the MBMS one, and `rt-mbms-*` is the stack it lands on.

## What is still missing

**There is no delivery parameters type for MBMS or 5G Broadcast.** A service instance chooses among
`DVBTDeliveryParameters`, `DVBSDeliveryParameters`, `DVBCDeliveryParameters`,
`RTSPDeliveryParameters`, `MulticastTSDeliveryParameters`, `DASHDeliveryParameters`,
`SATIPDeliveryParameters`, `IdentifierBasedDeliveryParameters` (clauses 5.5.18.1 to 5.5.18.8) or the
`OtherDeliveryParameters` extension point. None of them is MBMS.

Clause 9.3.3 nonetheless speaks of "a DVB-I service instance with an mbms:// locator", and that
phrase is the only occurrence of `mbms://` in the document: the behaviour is specified while the
element that would carry the locator is not. TR 103 972 clause 6.2.4 says an extension is needed so
that a service instance can refer to a 5G Broadcast or MBMS URL with delivery parameters of its own,
and notes it could be defined either in TS 103 770 or in an MBMS or 5G Broadcast specification.

Checked directly, and by fragments rather than whole strings so that a phrase broken across a line
or a table column could not hide: neither TS 103 770 V1.2.1 nor the A177r8 draft of V1.3.1 contains
"5GMS", "ServiceAccess", "AccessInformation" or "Media Streaming" anywhere. Neither cites TS 103 720,
TS 26.501 or TS 26.512 either, so the omission is not a matter of wording. This gap is open in the
published standard and remains open in its draft successor.

**Nothing carries 5G Media Streaming access information.** TR 103 972 clause 6.3.4 identifies that
service instance metadata needs to convey baseline 5GMS Service Access Information, suggesting a new
element used alongside `DASHDeliveryParameters`, with zero or more permitted because the information
may be available from several 5GMSd AF instances. It identifies further gaps on the 3GPP side, in
the M7 interface of TS 126 512, which are not ours to close.

**Instance selection is under-signalled for hybrid use.** TR 103 972 clause 6.4.3.3 recommends
against signalling a 5G Broadcast service as ordinary DASH delivery, because existing clients may
assume DASH means unicast, and prefers a distinct instance type. Clause 6.4.4.4 notes that where the
same content is offered on two instances, new signalling is needed to say that the two are identical
and time-aligned so a client may combine them.

## Gap by gap: what has closed since the report

TR 103 972 was published in 2023-07 and assessed 5G Media Streaming against **Release 16**. The
current specification is Release 18, and the client APIs have since been restructured into a
separate document. Most of its 5GMS gaps are closed.

Checked 2026-09-09 and reviewed again 2026-09-12, against the newest published issue of each
document: ETSI TS 103 770 V1.2.1
(2024-09), DVB A177r8 (draft V1.3.1), ETSI TS 103 720 V1.2.1 (2023-06), ETSI TS 129 116 V19.0.0
(2025-10), ETSI TS 126 512 V19.3.0 (2026-08) and ETSI TS 126 510 V19.2.0 (2026-08). Every gap in the
report is accounted for.

Each of these is the latest published issue: no V1.3.1 or V1.4.1 of any of the three DVB documents
exists on the ETSI deliverable server, and no newer release of the three 3GPP-derived ones.

Their histories since the report differ sharply. TS 103 770 was reissued once, as V1.2.1 in 2024-09,
more than a year after the report, and that issue closed one gap. TS 103 720 and the report itself
have not been reissued since. The 3GPP-derived documents have moved through two or three releases:
the report assessed 5G Media Streaming against Release 16 and the current issue is Release 19.

### 5G Broadcast scenario, TR clause 6.2.4

| # | Gap | Owner | Status |
|---|---|---|---|
| 1 | How `Keep updated interval` and `Periodic update interval` should be configured is unclear | TS 129 116 | **open**, unchanged |
| 2 | A 5G Broadcast Receiver is not required to support simultaneous reception of more than one user service | TS 103 720 | **closed**, before the report |
| 3 | Possible gap in the stage 3 xMB-C API for notifying the BM-SC of updates | TS 129 116 | **open** |
| 4 | A service class filter for DVB-I services needs defining by DVB | DVB | **closed** |
| 5 | A service instance cannot refer to a 5G Broadcast or MBMS URL | DVB or 3GPP | **open** |

**Gap 2 was already closed when the report was published.** TS 103 720 V1.2.1 clause 7.4 says a 5G
Broadcast Receiver should support simultaneous reception of at least four MBMS User Services on the
same carrier with different TMGIs, and that an MBMS Client should support simultaneous reception of
multiple services on one carrier. The report asked for exactly a recommendation and that is what the
clause gives. The dates are the point: TS 103 720 V1.2.1 is 2023-06 and the report is 2023-07, so
this gap was closed one month before the document naming it appeared. Its reference to TS 103 720
carries no version, which is how that happens.

**Gaps 1 and 3 are open, and nothing has moved, through Release 19.** TS 129 116 V19.0.0 still
defines Keep Updated Interval as the interval at which the BM-SC checks file resources for changes,
and Periodic update interval as the nominally expected time between successive updates of a file.
Both are defined semantically; neither carries guidance on how to choose values or how the two
interact, which is what the report found unclear. The change history records an xMB extension for
5GMS in V17.2.0, miscellaneous corrections in V18.0.0, and for V19.0.0 only "Update to Rel-19
version (MCC)", a version bump carrying no technical change.

On gap 3, the notification machinery in that API runs the other way: clause 8 specifies notification
push from the BM-SC to the Content Provider. For the Content Provider to tell the BM-SC that content
changed, what exists is polling through Keep Updated Interval rather than a notification. No push
mechanism in that direction was found, which matches what the report suspected.

**Gap 4 is closed.** TS 103 770 V1.2.1 clause 9.3.1 table 106 defines three service class
identifiers, `urn:dvb:metadata:serviceClass:DVB-I_Service_List:1`, `...DVB-I_Content_Guide:1` and
`...DVB-I_Service_Instance:1`, and the clause requires `userServiceDescription@serviceClass` to
carry the appropriate one. That is exactly the filter the report asked for, and it arrived in the
issue published a year after the report.

**Gap 5 is open, and stays open in the draft.** The delivery parameter choice offers eight types
(clauses 5.5.18.1 to 5.5.18.8) plus the `OtherDeliveryParameters` extension point, none of them
MBMS. Clause 9.3.3 nonetheless describes what a client does with "a service instance with an
mbms:// locator", the only occurrence of that scheme in the document. Neither V1.2.1 nor A177r8
mentions 5G Media Streaming in any spelling, nor cites the 5G Broadcast or 5G Media Streaming
specifications at all.

### 5G Media Streaming scenario, TR clause 6.3.4

| # | Gap | Owner | Status |
|---|---|---|---|
| 1 | Service instance metadata needs 5GMS Service Access Information | DVB, or 3GPP | **open** on the DVB side |
| 2 | Playlist entry needs the same | DVB, or 3GPP | **open** on the DVB side |
| 3 | No means to bind the Media Player Entry URL to Service Access Information | TS 126 512 | **addressed**, differently |
| 4 | No mechanism for implicitly launching the Media Session Handler | TS 126 512 | **not a gap**, the report says so itself |
| 5 | No notification that QoE metrics reporting was activated | TS 126 512 | **closed**, relocated |
| 6 | Playback state not explicitly exposed in M7 status | TS 126 512 | **closed** |
| 7 | No notification that a metrics report was submitted | TS 126 512 | **closed**, relocated |
| 8 | `OPERATION_POINT_CHANGED` carries no payload; no operation point in status; no external reference | TS 126 512 | **closed** |
| 9 | No client API to request network assistance | TS 126 512 | **closed**, relocated |

**The client APIs moved.** In TS 126 512 V19.3.0 the clauses the report cites for gaps 5, 7 and 9,
namely 12.2.5, 12.2.6 and 12.2.7, are all marked Void, and that material now lives in TS 26.510
(published by ETSI as TS 126 510), which 126 512 references throughout. The report's clause numbers
for those gaps no longer locate anything: the status has to be read in the newer document.

**Gaps 5 and 7 are closed** in TS 126 510 V19.2.0 clause 11.6.2. Table 11.6.2-2 lists
`METRICS_REPORTING_ACTIVATED` and `NEW_METRICS_REPORT` among the notification events the Media
Session Handler exposes, which are the activation and submission announcements the report asked
for, and table 11.6.2-1 adds `lastMetricsReport` status information alongside them.

**Gap 9 is closed** by clause 11.4 of the same document, a Network Assistance client API with its
own methods and status information, where the report found an empty clause.

**Gap 6 is closed.** TS 126 512 V19.3.0 table 13.2.6-1 now carries a `state` row holding an
enumerated value from table 13.2.2-1 indicating the current state of the Media Player, which is
precisely what the report proposed instead of inferring it from a non-zero playback rate.

**Gap 8 is closed, both halves.** `OPERATION_POINT_CHANGED` now declares a payload of the media
delivery session identifier together with the external reference identifier of the currently
selected Service Operation Point, and the dynamic status information exposes
`serviceOperationPoints` with an indication of which is current. The external reference the report
wanted, for correlating an operation point with a Representation in the MPD, is the mechanism
`externalReference` now provides.

**Gap 3 is addressed, though not in the way proposed.** The report suggested an additional M7
method. Instead, `attachMPD()` in TS 126 512 V19.3.0 clause 13.2.3.3 takes a media delivery session
identifier alongside the MPD URL, so the presentation is bound to an already-initialised session
rather than to the access information directly. Whether that satisfies the intent is a judgement
call rather than a matching of text, and it should be confirmed with 3GPP before being relied on.

### What this leaves

Of fourteen items, seven are closed, one is addressed by restructuring, one the report itself says
needs no specification work, and five are open.

The five open ones fall into two groups.

**Three are on the DVB side, and are the same shape**: the service list has nowhere to put a 5G
locator, whether for 5G Broadcast (clause 6.2.4 gap 5) or for 5GMS access information (clause 6.3.4
gaps 1 and 2). This is the group that blocks anything being built here, and it is small,
well understood, and squarely in DVB's court.

**Two are xMB provisioning details** (clause 6.2.4 gaps 1 and 3): how the two update-interval
properties should be configured, and the absence of a way for a Content Provider to notify the BM-SC
that content has changed rather than having it poll. Neither blocks a demonstration. Both would
matter to an operator running the provisioning chain in earnest.

Worth noting how stale a gap list becomes. One item was already closed a month before the report was
published, five more have closed since, and three of those closed in a document that did not exist
in its current form when the report was written. A gap list is a snapshot, and this one is three
years old.

The asymmetry is the other half of that observation. The 3GPP-derived documents have advanced two or
three releases since the versions the report assessed, and six of the seven closures are theirs. The
DVB side has been reissued once in that time, closing the seventh, without adding any means of
signalling 5G delivery. The gaps that remain open are, with two exceptions, on the slower side.

### How these findings were checked

Each status rests on reading the clause in the document that owns it, not on the report's
description of it. Absence is the hard case, and two traps were hit and corrected while doing this:

- A phrase can wrap across lines in an extracted PDF, so a whole-string search finds nothing where
  the text is present. This nearly produced a claim that two properties had been deleted from
  TS 129 116 when they had not.
- A phrase can also be split across table columns, where joining lines does not repair it either.
  The service class identifiers in TS 103 770 table 106 are split exactly that way.

Absence claims here are therefore made on short fragments that survive both, and corroborated by a
second signal: a specification that never cites another specification is not merely wording around
it. Anyone re-checking this work should use the same method rather than a plain search.

## What these repositories already provide

| Piece | Where | Relevance |
|---|---|---|
| Service list generation with an extension point | `rt-dvb-i-application-provider` | `OtherDeliveryParameters` with an `xsi:type` is already how HLS is signalled here, following TS 103 770 annex G.2.2. The same mechanism is what a 5G Broadcast instance would use. |
| A receiver that already handles unplayable instance types | `rt-dvb-i-application` | It parses DVB-T/S/C instances and lists those services with a badge rather than dropping them, which is the behaviour an unsupported 5G instance needs. |
| An MBMS Client and an MBMS-aware application | `rt-mbms-client`, `rt-mbms-application` | The two roles clause 9.3.3 describes, with a local API between them. `rt-mbs-*` is 5G MBS User Services (3GPP TS 26.502), a different system that clause 9.3 does not mention. |
| A BM-SC with an xMB-C interface | `rt-mbms-bmsc` | The provisioning side: where a service class is set on a service resource. |
| Object delivery over FLUTE | `rt-mbms-gw`, `rt-mbms-tx`, `rt-libflute` | The transport that carries the documents and segments. |

The pieces are unusually well matched. What is missing is the signalling that joins them.

## How carriage over MBMS should work

Everything in this section except the service list signalling is already specified. It is set out in
the order the documents put it, so that anyone building it knows which clause to open and which
piece has no clause at all.

### The unit of carriage is an MBMS User Service, and its class says what it carries

A DVB-I deployment over MBMS is not one bearer, it is a set of MBMS User Services, each announced
separately and each labelled with a service class. ETSI TS 103 770 V1.2.1, clause 9.3.1:

> "When conveying a DVB-I service instance or DVB-I metadata in an MBMS System this attribute shall
> be present and shall indicate the appropriate service class identifier specified in table 106."

Table 106 gives three, and a working deployment uses at least two of them:

| Service class identifier | The user service carries |
|---|---|
| `urn:dvb:metadata:serviceClass:DVB-I_Service_List:1` | one service list document |
| `urn:dvb:metadata:serviceClass:DVB-I_Content_Guide:1` | content guide documents |
| `urn:dvb:metadata:serviceClass:DVB-I_Service_Instance:1` | the media assets of one service instance |

So the service list, the content guide and each service's media travel as separate user services
with separate class labels. A receiver picks them apart by class, which is the whole point of the
attribute.

### Provisioning: how a document reaches a bearer

The content provider talks to the BM-SC over xMB, creates a service resource and sets its class.
ETSI TS 129 116 V19.0.0, clause 5.2.1.1, table 5.2.1.1-1, row `service-class`:

> "The service class that service belongs to. (see serviceClass element in clause 11.2.1.2 of
> 3GPP TS 26.346 [3])."

That property is what ends up in the User Service Description the receiver eventually reads. 3GPP
TS 26.346 V19.3.0, clause 11.2.1.2:

> "The serviceClass attribute is optional and contains the service class identifier for the
> delivered service according to the syntax defined in clause E.1.2 of [90]."

Optional there, mandatory here: DVB narrows it, which is what clause 9.3.1 above does.

For the media of a service instance, the User Service Description must also point at the entry
point document the player will be given. 3GPP TS 26.346 V19.3.0, clause 5.2.2.1:

> "In the event a MBMS User Service carries DASH-formatted contents, the userServiceDescription
> element, representative of the User Service, shall contain a mediaPresentationDescription element
> and/or a r12:appService element."

The user services are then announced. 3GPP TS 26.346 V19.3.0, clause 5.2.3.1 lists four ways a
client can obtain the announcement session parameters, of which pre-storing them in the receiver and
resolving a well-known FQDN are the two that need no other channel. For LTE-based 5G Broadcast this
is narrowed further. ETSI TS 103 720 V1.2.1, clause 5.4.2:

> "LTE-based 5G Broadcast requires the usage and support of 5G Broadcast SA Services for service
> announcements."

### Receiver procedure, in the order clause 9.3.3 gives it

**1. Start the announcement channel.** ETSI TS 103 770 V1.2.1, clause 9.3.3:

> "The DVB-I client (acting as an MBMS-Aware Application) shall first invoke the MBMS Client to
> start receiving the MBMS Service Announcement Channel, as specified in clause 5.2.3 of ETSI
> TS 126 346 [39]."

The result is a User Service Description for every user service in the system, most of which have
nothing to do with DVB-I.

**2. Read the class off each one.** ETSI TS 103 770 V1.2.1, clause 9.3.2:

> "The service class identifier shall be exposed by the MBMS Client to the DVB-I client (acting as
> an MBMS-Aware Application) as specified in clause 6.2 of ETSI TS 126 347 [40]."

This is the filter. Without it the receiver cannot tell a DVB-I service list from any other file
being broadcast.

**3. Acquire the metadata, and keep it current.** ETSI TS 103 770 V1.2.1, clause 9.3.3:

> "If it has no unicast network connection, the DVB-I client (acting as an MBMS-Aware Application)
> shall attempt to acquire a DVB-I service list from an MBMS User Service of the appropriate service
> class, and may subsequently also attempt to obtain DVB-I Content Guide metadata from an MBMS User
> Service of the appropriate service class."

Note the condition: this path is for a receiver with no unicast connection. A receiver that has one
may fetch the list over HTTP as usual, which is what the demo in these repositories does. The same
clause then requires the receiver to subscribe to MBMS Client notifications and pick up new versions
as they are announced, which is the broadcast equivalent of the version polling a unicast receiver
does under clause 4.3.3.7.

**4. Select an instance and hand off to the player.** ETSI TS 103 770 V1.2.1, clause 9.3.3:

> "When a DVB-I service instance with an mbms:// locator is selected by the user, the DVB-I client
> (acting as an MBMS-Aware Application) shall invoke the MBMS Client to initiate reception of the
> corresponding MBMS User Service."

The player is never given the `mbms://` locator. The same clause requires the entry point document
referenced by the User Service Description, an MPD in the DASH case, to be passed to the media
player instead. In practice an MBMS Client reconstructs the received objects and republishes them
over local HTTP, so what the player sees is an ordinary MPD URL.

### The one piece with no clause

Step 4 begins "a DVB-I service instance with an mbms:// locator", and nothing in TS 103 770 says
which element carries that locator. That is gap 5 above, and it is the only thing in this whole
procedure that a deployment has to invent. This repository invents it as
`schemas/dvbi-5g-ext-1.0.xsd`, in a 5G-MAG namespace and marked as an extension everywhere it
appears; see COMPLIANCE.md. It carries the locator, the service class from table 106 so a receiver
can check rather than assume, and a unicast fallback URL.

Choosing the class in the service list matters: it is what lets a receiver match an instance against
the announced user services without opening each one.

### What each component would have to do

| Component | What it does here |
|---|---|
| `rt-dvb-i-application-provider` | Emits the service list, including the extension. Already done. |
| `rt-mbms-bmsc` | Accepts a service over xMB-C with `service-class` set to the table 106 value, and puts it in the User Service Description. |
| `rt-mbms-gw`, `rt-mbms-tx` | Carry the service list document, the content guide documents and the media segments as file objects. |
| `rt-mbms-client` | Holds the announcement channel, reconstructs objects, and must expose the service class of each user service, which clause 9.3.2 requires and which it does not do today: `GET /client-api/service_announcement` returns the parsed announcement items with no class on them. |
| `rt-dvb-i-application` | Acts as the MBMS-aware application: ask the client for user services of class `DVB-I_Service_List:1`, load the list from the reconstructed copy, and on selecting an extension instance ask the client to start reception and then play the MPD it republishes. |

The smallest useful step is not step 4. It is publishing the service list itself as a user service of
class `DVB-I_Service_List:1` and having the receiver load it from the MBMS Client's local HTTP copy:
that exercises provisioning, the class label, the announcement channel and object delivery, and it
needs no extension at all, because a service list carried this way still describes ordinary unicast
instances.

### What this section does not establish

- ETSI TS 126 347 is not held here. Clause 9.3.2's reference to its clause 6.2, and anything about
  how the `mbms://` scheme is formed or how an MBMS-aware application calls an MBMS Client, are
  `unverified: could not obtain ETSI TS 126 347`.
- The service class syntax comes from OMA BCAST Service Guide V1.1 clause E.1.2, which is not held
  here either. The three values DVB defines are given verbatim in table 106, so nothing above
  depends on that syntax.
- Nothing here has been built or run. The statement about `rt-mbms-client` not exposing a service
  class is code-derived, from its README and a search of its sources; everything else is
  source-derived.

## What would need building

In the order that yields something demonstrable soonest.

1. **Decide and document the delivery signalling.** Since no standard element exists, a
   demonstration has to choose one, and must be explicit that it is a local extension rather than a
   specified one. `OtherDeliveryParameters` with a private `xsi:type` carrying the MBMS service
   locator is the option TR 103 972 clause 6.4.3.3 effectively points at, and the option it warns
   against is dressing it up as ordinary DASH delivery. Whatever is chosen should be recorded in the
   conformance record as an extension, so it is never mistaken for conformance.

2. **Emit it from the provider.** A new instance type alongside the existing DASH one, so a service
   is offered on both unicast and 5G, which is the hybrid case of TR 103 972 clause 6.4.

3. **Publish the service list itself over MBMS.** Clause 9.3.1 already defines the service class for
   this, so the provisioning side is specified: a user service of class `DVB-I_Service_List:1`
   carrying the list document, which the MBS stack can already deliver as an object.

4. **Teach the receiver the new instance type.** It should list such a service, and where an MBS
   client is reachable, select it by asking that client to start reception. In a browser receiver
   this means talking to the MBS application's local API rather than fetching a URL, which is a
   larger change than the previous three.

5. **Only then, the 5GMS path.** It depends on gaps that are 3GPP's to close, not ours, and the
   report says so.

Steps 1 to 3 are achievable with what is in these repositories now. Step 4 is the substantial one.
Step 5 is blocked on standards work.

## What this assessment does not establish

- Whether DVB intends to close these gaps in V1.3.1 or later. The draft does not, but a draft is not
  a plan of record, and the question belongs to DVB.
- Anything about the 3GPP-side gaps in TR 103 972 clause 6.3.4 beyond repeating them: they concern
  TS 126 501 and TS 126 512, which were not consulted here.
- Whether any of this interoperates. Nothing described above has been built or tested.
