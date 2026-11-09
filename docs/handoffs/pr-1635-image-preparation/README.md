# PR1635 private source integration

The parent adapter applies to frozen parent `facf1f1f8613293a82f153a7688e36866b274ecd`.
It is separate from the main infrastructure repair. Do not import the parent's
unpublished `cloudbench_maintenance.py` into main or reinterpret its failed
native activation `e9895d980baaf10648039d8e9dd3067b` as successful.

The adapter SHA256 is
`de73a889193a67c16dc562109998a72d7aee70b52f52273b5e33f4ac2a31801a`.
Integrate the reviewed infrastructure commit first, including the version-two
source parser, native producer/creator, source lease helper, fleet consumer,
snapshot dependencies and recurring tests. Then apply this five-file adapter
with `git apply --check` before `git apply`. Preserve both sides' intended
changes if later parent source differs; revalidate the combined frozen source.

The adapter reuses the parent's existing source transport producer: fetchable
base plus SHA256-sealed workspace patch and independent Git-index reconstruction.
No premature parent source push is required. A future parent integration must
regenerate this transport on its actual combined snapshot. The old facf patch
is forensic proof, not execution or cleanup authority.

The native source producer binds its own exact script/dependency bytes separately
from the requested parent guest source and image. Parent image
`sha256:566037c7709a963dbd8fed0925e1d1a0f58fd82fb906064f1e29899d734e85d3`
was independently matched to its recorded build and facf image input trees.
Main's image inputs differ and require their own publication; never substitute
one image or source for the other.

The parent cycle's `prepare-private-source-transport` and
`prepare-private-source` actions retain the existing exclusive cycle lock,
source/plan binding and historical debt audit. The preparation callback writes
and directory-fsyncs the original intent before native effects, then binds the
actual producer origin, dependencies, original creation authority, lease/CAS
journal, guest observations and captured manifest. Missing authority refuses.
Both protected Machine/volume mappings remain exact. The seven original cleanup
debts, six financial warnings and all 621 historical failure records remain
preserved, without new credit.

New private sources publish version-two manifests. Legacy readers reject them;
the supported fleet reader takes a native per-source lease and durable consumer
claim before admission. Expiry or a crash retains the claim. Retirement requires
the same lease and exact consumer closure through the original canonical fleet
audit and lifecycle; a quiet inventory snapshot is insufficient.

Offline adapter evidence includes unchanged causal failure against original
parent hooks, 21 seam checks, exact full facf patch reconstruction, and combined
native HTTP/callback/verifier composition. These are supporting proofs. Real
bounded native integration, final affected gates, exact source review and the
repair's production deployment remain required before integration is complete.
The parent owns subsequent execution of its original deployment cycle.
