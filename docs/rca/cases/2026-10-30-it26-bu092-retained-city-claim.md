---
id: 2026-10-30-it26-bu092-retained-city-claim
date: 2026-10-30
title: BU092 returns a supported year after an incorrect city-list claim
surface: agents
component: browser-actor-and-declared-evaluation
classification: unresolved
problem_class: other
first_bad_boundary: Captured actor response lists Mostar among the top four cities and is persisted unchanged before later evidence identifies Zenica
symptoms:
  - Native COMPLETED with progress 1 and final year 1942
  - Declared C3 rejects an earlier city-list claim
  - C1 C2 C4 pass while the original benchmark fails
tags:
  - r110
  - it26
  - bu092
  - retained-claim
sources:
  - commit 7e557a39083db505203e9e9bdf697e6c1a3f5a98
  - agent cd76b7df-aa6b-4e8b-af49-de5079b11399
  - plan:.context/r110/proof.json
repro: original sealed packet and captured actor/verifier records only
status: open
---

## Problem

It26 BU092r1/r001-j0002 asks the year of the event commemorated by a pre-1970
monument in a top-four Bosnian city, designed by an artist born in 1928.
The original native task completes in 503.7 seconds with progress 1 and final
answer 1942. The independent evaluator passes C1, C2 and C4 but fails C3 for
an earlier city-list claim. The canonical benchmark is FAILED, producer
infra FALSE, cleanup_failure absent. These outcomes remain unchanged.

## Diagnosis

Archive SHA c82230263af03d47c1cce5fa71a10c352058ddbe0865a1ed461133e743272cb4
and every normal manifest member's size/SHA independently verify. Manifest
SHA 64e8cf6a8a96c06acfc2e57c1beb0fc14dc2dacc89357fff9eccc9773f7e1b8a;
run SHA 0e136fbbc70a568702abf9873036a5c7b10605f977393ce30586f5962e7698a3.
Executed source is 7e557a, patch none. Supplemental driver/provenance records
are distinct from the seven-member normal manifest.

Captured browser step14 response, dump83a9abb12d94 at worker16898, states that
the top four cities are Mostar, Sarajevo, Banja Luka and Tuzla, and claims to
have noted census counts. Its action.thinking and reasoning are exactly equal
to the persisted assistant message at zero-based index68 (judge step69).
The full captured application dump SHA is
7081c9b7cf963b788a127fd9ab97d1919a9aef8d3b43d37748712bd387de2841.
No observed parser, transport or persistence transformation introduced this
claim. The captured actor input includes earlier searches using Zenica and
later a monument table containing Mostar; this does not establish why the
model substituted the city. No raw provider-wire parity or model replay is
claimed from the application dump alone.

The schema author required only event_year as an integer and retained the
user's top-four-city condition without inserting Mostar. Its explanatory
reasoning lists Zenica. Raw schema-output dump SHA is
169b30781e89d4def70300c70ae02d988e3909e1e314b46578393569114932e1.
Thus the observed incorrect city assertion is not a schema-required answer
or an output-field conversion failure.

Later captured Monumentalism observation at message79 explicitly describes
Zenica as the fourth-largest city. Spomenik Database at message88 identifies
the Zenica monument, designer Arfan Hozić, 1968 completion and the fatal event
on May 8, 1942. The final verifier uses those retained sources and the artist's
1928 birth year. Input SHA
e0f6eb7b819920eb17f7ee9eb1874905219c21b7351c75755488e75673afd4dd;
output SHA 698e48983d6748ad3724421a941158cd2a6fa4e4880261a7c9fa6056e4c5319a.
It returns event_year 1942, task_completed true, score 1.0. Final response is
1942. This validates a final output field; it does not erase earlier claims
from the trajectory assessed by the independent C3 criterion.

Two archive searches and the complete prior Solution/Human feedback sections
for BU087 unsupported distance and BU072 earlier contradictory date were
read after the original trace. They are comparator patterns of an earlier
claim surviving a supported final answer, not proof of a shared runtime bug.
Cleanup independently records Tilion DELETE204, no errors or warnings.
No positive operational infrastructure failure was established.

## Solution

OPEN: no general causal runtime repair established from these records.
Do not replace the historical claim, weaken C3, suppress all intermediate
responses, force the year, or treat final native score1 as the original
benchmark result. A claim-generation/revision mechanism would need separate
causal evidence and compatibility proof; this bounded intake does not justify
a new prompt, schema, model, budget or transport patch. No live calls or
replay were made.

## Human feedback

Parent requested original actor/input/schema/verifier evidence before family
assignment, preserved native-versus-benchmark axes, and required no answer
hack. This is a docs-only future child of e01233d; active source7e remains
unchanged. R106/R108 qualified code is preserved without new runtime changes.

## Reusable lesson

A supported final answer and a truthful final extraction do not establish that
every earlier actor claim was grounded. Preserve the original claim and its
later contrary evidence before proposing a transport or schema repair.

## R113 original It27 BU092r1 comparator

Executed source98c8668b47b5e9b2fd2b807c2f083f2e46a04733, patch none,
root557ce880-00e3-4429-9f55-e78a531dbbf2. Archive
 a8a20f08fd067fbdbecf07fab46e9b90919bd96bfe9f621212fb41359d0cc261
and all seven normal member hashes/bytes independently verify. Manifest
 a39845687a57760757e36c55606b0b5d9bcf834f353f1053cdf7f011fc619037;
run d86bb06a27dfca07d8570854400275acc82d21ea37e28c8a49e63aaf1628adc0.
The supplied source archive SHA is
58b9b6fafcb984eef1d0d43f1320b0e7933a5356b89e4abd3291ac0300a53220.

Native COMPLETED638.8s/progress1, canonicalFAIL, producerinfraFALSE,
C1/C2/C4PASS and C3FAIL. The final answer1942 is supported; the independent
C3 rejection concerns a different retained intermediate statement from R110.
At zero-based message32/judge step33, the captured actor says it is clarifying
the artist and describes “the 1960s monuments in Sarajevo, specifically the
Vraca memorial.” Preserve the full hedged context: the uncertainty concerns
the artist, while the description contains the disputed date attribution.
The corresponding browser-step5 application dump9b4dcc49be53, SHA
f708b658a2ba731aa3c5de7a32cf07c7a04836c828d2fd652065b2597a4595a3,
contains exactly the same action.thinking as the persisted assistant message.
No observed output parsing or persistence mutation creates the claim.
The captured Wikipedia observation at message41 states Vraca opened on
25 November1981. No new site lookup or inference call was made.

A distinct schema-author observation must not be hidden: raw schema-output
SHA ddf096c0be7feeced449499e4e424aa3c85123f9cc2042adba0cf9e22fa91545
adds “e.g., the1941 uprising in Sarajevo” to the event_year description and
speculates about a specific monument in its reasoning. The user did not
supply that example. It survives into the captured actor and verifier schema
instructions. This supports an author answer-contamination lead, but does
not prove that the1941 example caused the later Vraca1960s statement.
The final verifier did not blindly adopt it: raw input SHA
39295eb3f233410f4dbcd05c47440e9832177e873e120f2d4b3ba5b71ff58042
contains the1981 contrary page evidence; output SHA
cf977e3d1b373a86f320ae781be37fd791130299c44f9e36a6346b8ecdd18f6f
returns event_year1942, task_completedtrue and score1 using the Spomenik
Database and artist-birth evidence. Its output-field verification does not
remove the earlier statement from the separate C3 trajectory assessment.

Two archive searches and the complete R110 and BU087 unsupported-distance
Solution/Human feedback were read after the original trace. This is a related
retained-claim pattern with a different concrete claim, not proof of the same
runtime cause. OPEN: no general mechanical repair or operational transport
failure established. Do not alter the original claim, rubric, native grade,
prompt, or task. No new replay or model call was performed. Cleanup reports
Tilion DELETE204 with no errors/warnings. R113 is an append-only offline
investigation; it neither deploys the qualified future changes nor counts as
a repaired benchmark result.

## R116: It27 BU098r2 retained film-runtime assertions

This recurrence is limited to the observed **raw actor assertion → unchanged
persisted statement → later contrary evidence** boundary; it does not establish
a shared generation cause. Original root
`18e0b195-e328-4110-bba3-440abd4d0e3e`, task `polar-bu-098`, source
`98c8668b47b5e9b2fd2b807c2f083f2e46a04733`, patch none. Native
COMPLETED795.3s/progress1 and canonicalFAIL/C3FAIL remain distinct. C1/C2/C4
pass; original producerinfraFALSE is unchanged.

All seven normal files independently match their manifest sizes/hashes.
Normal run SHA256 is
`36d8d32503b9353341186377b1b159ed17300b9aac242b54f2c9fa48aa753845`;
worker SHA256 is
`35f4abeb2eb63b982446216beef98ab2b4ae0546215a470b303feb5c243c711a`.
The user asks for a1980s film lasting95–110minutes with director and writer
biographical clues. Raw schema output worker85,
`a2d6d299ff441c2e52f49403bbd7dbd1ca1c9abacdfba747367df4094b6fb9ef`,
requires a generic movie_name string and inserts no specific title/runtime.
Its persisted value/text presentation matches the requested movie-name output.

At zero-based message66 (judge step67), the actor states that Nineteen
Eighty-Four runs113minutes and Another Time Another Place runs98minutes. Raw
browser_use_step_14 output at worker12859, SHA256
`9361b3865a48f1a0fef6a959109cad5fa0d05c50ebe49a188642554a459a332d`,
has action.thinking exactly equal to that persisted message. Its captured input
contains no standalone113 runtime or factual98-minute runtime; occurrences of
98 are DOM element indices. The actor also says it needs to search for
“pollution from similar queries across agents.” That generated phrase is not
evidence that cross-agent contamination occurred. No observed parsing or
persistence transformation introduced the disputed claims.

Later original observations contradict them: message70 shows118minutes for
Another Time Another Place; message78 shows110minutes for Nineteen Eighty-Four.
Message74 gives107minutes for White Mischief. The original C3 rejection follows
these contradictions. It is not a rejection of the final movie name.

Final browser-verifier input worker18413, SHA256
`b2257860170dde6a7664c7ebd46af626b6b4ed14ad78842ad757a351b4b9b679`,
contains the118/110-minute evidence but not the113/98-minute assertions. The
verifier prompt explicitly omits actor reasoning. Output worker18425,
`39ffa821b5bb0c1b9adf0f94f428c29facc2f808d40771bbcc78f8c793b8aaea`,
returns White Mischief, task_completedtrue, score1, while distinguishing the
book author James Fox from the evangelical actor and noting the mistaken
writer clue. Final output-field verification does not erase earlier claims
from the independent full-trajectory C3 assessment.

Two archive searches used film-runtime/intermediate-claim and
contrary-evidence terms. The available local search index was older than98c;
its results were leads only. The full supplied retained-city and R113
comparators and the streamed-commentary parsing case were read. Unlike that
parser defect, raw actor and persisted text agree. Why the actor generated
those runtimes remains OPEN: no model replay, raw provider-wire comparison,
or causal intervention was performed. No forced title, reasoning suppression,
prompt edit, criterion change, timeout change or runtime fix is justified by
this record. All original grades and facts are preserved.

## R126: It30 BU096r2 retained basketball-score assertion

This append shares only R116's observed **raw actor assertion → unchanged
saved statement → later contrary evidence** boundary, not a proved common
model-generation cause. Original root
`e81baac3-f7a5-434a-893d-ffe1fedf6a58`, source
`691b9059a9ca3b41552be9679d712b50edcf24d5`, patch none. Native
COMPLETED196.2seconds/progress1, benchmarkFAILED, C1/C2/C4PASS and C3FAIL
remain distinct and unchanged. The final two names are supported by the
retrieved evidence; the original full-trajectory failure remains valid.

Archive SHA256
`773415206e346a354500ddc538840a4862baa326132aa484acc46a4aa7d80fb7`
and all seven normal manifest member lengths/hashes independently verify.
Normal run SHA256 is
`6815241d28625f1c840bb1d49bc86b4ac39af46f25a7c183c2eff6dc6e173316`.
All21 captured application payloads were decoded and hash-checked.

At saved message33, the actor claims Sabonis and Marciulionis “both scored27.”
The full passage explores Venezuela–Lithuania and Venezuela–China candidates;
uncertainty about the matching game does not change the concrete scoring
assertion. Original browser_use_step_7 output at worker7394 contains that same
reasoning and action.thinking. Its reasoning equals the saved message exactly,
string SHA256
`b05631fd0498111aa833d996c09f4ba9dcb70a349c6ea52b9266c7ac2ff4fc0f`.
No observed persistence or parser transformation introduces the claim.

The later original box score at message39 shows Arvydas Sabonis24 and Sarunas
Marciulionis27, contradicting the shared27 assertion. Message43 identifies
Venezuela's96–88 win over China, a52–52 first half, three scoreless players
with4+7+2minutes, and Zhang Yongjun as Did Not Play. It shows Carl Herrera
and Gabriel Estaba scoring23each, supporting the final names.

Schema-author output worker109 contains a generic two-item
winning_team_top_scorers list with first_name/last_name. It inserts no player,
date or scoring example that explains the erroneous assertion. Final native
verifier input worker7681 omits the earlier both-scored27 claim; output7691
returns the supported names, task_completedtrue and score1. This narrower
final-output check does not supersede C3's full-trajectory assessment.

Successful native actions continue through completion. Worker7747 closes CDP
normally at21:56:23, child structured completion follows at7791, and root
COMPLETED is recorded at7834/21:56:47. An earlier invalid_request_error and
response-body/readiness warnings are followed by successful work; no positive
unrecovered operational transport failure was established. R119's prior
same-task transport symptom is not this incident's cause.

Two local archive searches were followed by reading the exact supplied
R110/R113/R116 and R117 cases. The local search index was older than691b, so
search results alone were not current coverage. Unlike R117, this schema has
no unsupported specific-answer anchor. OPEN: no causal intervention explains
why the actor generated the scoring claim, and no general runtime fix follows
from faithful persistence or differing verifier scope. No provider/model/native
call, task-specific prompt, schema change, reasoning suppression, rubric
relaxation or grade promotion was performed. The live controller was not
changed or stopped by this RCA worker.


## R129: original It30 BU093 paired quote-date claims

Both original source691b9059a9ca3b41552be9679d712b50edcf24d5/patchnone runs
completed natively with progress1, but each declared C3 failed while C1/C2/C4
passed. Run1 rootd294b83d-6e56-4c3c-8bfa-55df4f4eb329 took2075.8seconds;
run2 root3d5d1f11-e614-46a5-98d0-5c9e1443a3b6 took1382.7seconds.
Both cleanup_failure values are null. Native completion and correct final
answers do not replace the original three-of-four benchmark FAIL/infraFALSE.

Archive hashes are6e4272f9f6910c87f6f7ec0b68fa724615d74a4c976230b40be154b3cbd1b352
and2a0c6dae199d2a1eaefd2ac3da1b487eb99c1acc5e0bbbce2db8b12f5ae0ecd5.
All fourteen normal members were independently checked against manifest
f3ecc3725f21057e796bca62418fc1ac3eff84b7077398c1c36b8fee9556f78a and
72b4c6dfbd4ab1b12f5a68d97b0d5dd4570da6cefdb7416c521268e40262a864.
All168 captured compressed model payloads were decoded and SHA-checked.

Run1's browser_use_step_19/request0a6624579cde reasoning exactly equals
persisted assistant zero-based message index72 (judge step73): it dates “Figures don’t lie,
but liars figure” to1869. The request contains the task's1869 clue, but neither
1884 nor1933. This precedes the retrieved contrary article: zero-based message index78 (judge
step79) gives1884 for the full proverb and a differently worded1869 precursor.
The authored claim SHA256 isda9ad41adaf40692fe723fafd7efe60ef784180572ed6ace80ece4bc9c07b5b1;
the original response payload is4eaa6bad39e570d65f852b4d3e0284064a9c3cb255d26aa9afcd710711c1a0ce.
It is not a demonstrated ignored1884 fact at the earlier authoring call.

Run2's browser_use_step_23/request1cb72a62caa7 reasoning exactly equals
persisted zero-based message index106 (judge step107): it says the earliest citation attributed
to Bismarck dates to1869. Unlike run1, its exact input already contains the
1933 textbook statement. Zero-based message index105's extracted Quote Investigator passage
explicitly distinguishes the1933 Bismarck attribution; the1869 citation belongs
to John Godfrey Saxe. The authored claim SHA256 is
3098f5da599a76a0b483ee460932b2060d70077dc29309a0c2a7da2ed0ad0f1c;
the original response payload is
ed4069ce1a8b3a4a965e0f2c2d0323ca89eed6355772475bd7d248676bb3e074.
The two distinct input-evidence timings must not be collapsed into one cause.

Both schemas faithfully ask for one required nonnullable textbook-name string
with value/text presentation. Both original native verifier calls return
“Government in the United States”, task_completed=true and score1. Their
captured final inputs contain the supporting1933 statement; the complete
intermediate false claims are not present there. This final-answer check is
separate from the declared full-trajectory C3 check. Exact-source
build_polar_trajectory retains each original assistant claim; an offline
projection using those same recorded messages confirms this without a model
call. No separately captured raw declared-judge HTTP payload parity is claimed.

The source saves the actual thinking into assistant messages and retains
assistant text in Polar's trajectory. No altered persistence, dropped schema
field, incorrect final scalar or transport substitution is demonstrated.
The earlier claims remain real authored errors even though final answers are
supported. The precise deeper cause is OPEN; no controlled model comparison
or general mechanical repair is established. Removing the claims, rewriting
reasoning, overriding the answer, or relaxing C3 would hide the failure.

Archive searches used “trajectory factual claim contradiction correct final
answer” and “BU093 textbook1869 proverb”; the earlier C3 case and this retained-city case's Solution and
Human feedback were read before this append. This is a related retained-claim
boundary with paired original evidence, not proof of one shared deeper cause.
No runtime/prompt/criteria/model change, new provider call, replay or regrade.
Tokens UNMETERED.


## R130: original It30 BU099r1 street claim

Original r001-j0009/rootd38f2302-a79a-4147-bad7-2bb9ecf75e28 ran exact
691b9059a9ca3b41552be9679d712b50edcf24d5/patchnone. Native COMPLETED2771.2s,
progress1 and supported final Walter Allen remain separate from declared
C3FAIL, C1/C2/C4PASS, benchmarkFAILED/producerinfraFALSE. Cleanup_failure is
null. The user asks which business partner was no longer listed; the numbered
street clue gives only a number between1 and10, not Fourth Street.

Archive b96d9dbdbf8927abac691ebaaaf61898780d1247309e3fb66f4f514a60084817
and all seven normal members independently verify against manifest
908602af594f439dbff2648dfe51f7839d32d20fb4049c928f7955d058794938.
All94 captured compressed model payload hashes verify. The schema asks for
one required nonnullable owner_no_longer_listed_name string with value/text
presentation. It injects no street name or candidate person.

The first browser actor response, browser_use_step_1/dumpc09aa8070877 at
worker1633, states that the partnership moved to Fourth Street. Its original
reasoning equals the persisted assistant message at zero-based index15
(judge step16), SHA256
676304f9080a040a3585927bf13b1356b8d56baf5f1405e2df7fa8eed6cd8b0e.
The request/response application payload SHA256 is
71dfb2044a2bf99e09af230313a00578871ab77d8aa290ed01222126487f1fbe.
The exact request messages contain neither Fourth Street, 3rd Avenue nor1916.
Thus no observed parser or persistence change introduced the statement, and
this is not evidence that the actor ignored an already-read3rd-Avenue record.

Later, zero-based message248 (judge step249) contains Archives West collection
text: Frank Perkins and Walter Allen operated the Georgetown Photograph Studio
in1911–1915; it moved to717½3rd Avenue in1916; only Frank Perkins is listed
there in1917–1920. That text also identifies Gertie Fae Perkins and the later
locations. Message text SHA256 is
3329dce9c762a268000e2f45f17fdc2fca394e6f748e51715b4cabbbf34f46f7.
The native verifier request SHA256 is
a2dd86897ec7d88bd3e29024eab7973118e2d8017fe5032acf7cb2a783cfc494;
response payload90e083f1480e556880149e77247ec3312b22845dbfdcfc94e987bd469152e248
returns Walter Allen, task_completedtrue and score1. The Fourth Street claim
also remains in this verifier's captured input; final-answer acceptance does
not establish whole-trajectory accuracy. Exact691b Polar projection retains
that original claim. No independently captured raw declared-judge HTTP parity
is asserted.

A separate integrity limit is visible in the original history: before the
Archives West extraction, the browser navigated to
https://arxiv.org/html/2607.08662. Zero-based message227 extracts the same
question and a sample search/verifier trajectory naming Frank Perkins and
Walter Allen; its text SHA256 is
7983aa76323e684bc605d7b1d2a2c03cb5b35e1d48cd19a95c546f39a289cab4.
This observed answer-source exposure is separate from the later primary
collection evidence and from cache/mode classification. It does not establish
independent discovery of the candidate, a cache replay, or a causal explanation
for the much earlier Fourth Street assertion. No new paper fetch was made.

Archive searches used “Fourth Street Walter Allen” and “retained intermediate
claim correct final C3”; the existing semantic-family Solution/Human feedback
and R129 distinctions were read. This append records another observed
actor-claim/persistence/contrary-evidence boundary without asserting a common
generation cause. OPEN: no justified general runtime repair, model-only proof,
forced answer, reasoning suppression, evaluator edit, replay or regrade. All
original outcomes remain intact. Tokens UNMETERED.
