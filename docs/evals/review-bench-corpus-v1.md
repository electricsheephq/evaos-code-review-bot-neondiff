# Review Bench Corpus v1 contract

Review Bench Corpus v1 measures defect detection in an exact proposed change.
It is not a repair benchmark, a debugger benchmark, or a license to treat every
historical bug-fix PR as a positive review example.

## Reviewed-state invariant

Every scenario declares:

- `taskKind: review_defect_detection`
- `artifactSemantics: defect_present | verified_clean`
- a `review-bench-oracle/v1` descriptor whose digest names an external
  `review-bench-oracle-evidence/v2` packet excluded from model input

For a defect scenario, the independently adjudicated gold finding must be true
of the exact pinned base/head diff sent through the review prompt and current
RIGHT-side gate. A later fix, revert, test transition, or exact-head review
comment can establish that truth, but repair evidence must not be the same
revision as the reviewed artifact. The oracle source must be a canonical
repository-bound GitHub commit or review-comment API record. Unversioned fault
reports are not accepted in v1. A bug-fix diff cannot be labeled with the defect
it removes.

For an explicit control, `artifactSemantics` is `verified_clean`, there are no
gold defect labels, and a `clean_adjudication` oracle is bound to the exact
reviewed source revision.

Oracle text, later fixes, regression-test explanations, adjudication notes, and
other answer-bearing evidence remain outside the model prompt. The prompt-facing
metadata projector allows only its schema version and one closed-enum language;
repository, revision, artifact digest, scenario IDs, and all scoring metadata
stay in a non-provider execution envelope. Diff bytes travel separately. This
prevents public-source lookup keys and unrestricted IDs from becoming answer or
memorization channels. The corpus hash binds the oracle identity and evidence
digest so they cannot be swapped without invalidating the corpus.

Each digest-named `.oracle.json` packet binds the scenario, repository, exact
reviewed revision and artifact digest, oracle identity and relation, rubric,
method, completion time, and sorted covered label IDs. It contains immutable
primary and secondary decisions made blind to provider identity and to each
other. Before either decision, the packet freezes a
`review-bench-annotation-universe/v1`: a protocol-hash-bound, duplicate-free set
of candidate ID/path/line/title/body records. Every candidate must be grounded
on a final-side line of the reviewed diff, and both adjudicators must rate every
candidate even when they reject it. Final gold labels must be the
identity-preserving actionable subset of the agreed or resolved universe.
Reconciled cases require a materially different pair of decisions and a
third distinct resolver. Corpus v1 accepts only canonical `human:*` identities;
agent-assisted suggestions cannot stand in for either adjudicator or the
resolver. The packet binds the full canonical gold-label content and maps each
label to the exact live-verified oracle-source digest and evidence path. Accepted
gold severity must equal the agreed or resolved severity; the one-tier tolerance
is only a model-matching and inter-adjudicator agreement metric. The packet is
descriptor-read, size-bounded, fatal-UTF-8 decoded, secret-scanned, canonical-
JSON validated, and raw-byte hashed before any network request.

Commit-backed later fixes, reverts, and test transitions are live-verified for
commit existence, reviewed-revision ancestry, chronology, immutable diff bytes,
and the presence of every mapped evidence path in that diff. Review-comment
oracles are limited to one-label pull-request scenarios and are live-verified
    against that exact source PR, reviewed head, and the gold label's exact
    RIGHT-side path/line, plus comment body, creation time, and last-update time.
    The last update must not precede creation and is the oracle observation time,
    so later edits invalidate the evidence digest. A syntactically valid
but nonexistent, unrelated, or location-mismatched oracle cannot produce an
admission receipt.

Every clean control also carries `review-bench-clean-observation/v1` and must
come from a closed, merged PR into the repository's current default branch. Live
admission uses GitHub's server `Date` and server-authored PR `merged_at` values,
not author-controlled commit dates, to enforce at least 30 elapsed days. The
observation checkpoint is itself a separately pinned later PR merge into the
same default branch. Admission proves its merge commit and the current head are
on the source merge's lineage, exhaustively binds at most 250 source-to-checkpoint
commits, rejects linked corrective commit messages, and checks one complete
100-event PR timeline page plus one complete 100-comment post-merge page for
cross-referenced or discussed regressions, hotfixes, and reverts. Evidence and
human decisions must predate admission, and clean decisions must follow the
observation cutoff. Comment creation and update times are both checked, so an
edited pre-merge comment cannot hide post-merge corrective discussion. More
history or paginated signal evidence fails closed.
These are bounded negative-signal checks plus blinded human review; they do not
prove that a latent or unlinked defect is impossible.

Rubric and adjudication protocol are separate digest-named Markdown artifacts,
each versioned in its first heading and hash-bound to the corpus and evidence.
Canonical ASCII human adjudicator identities close Unicode/case aliasing.
Admission computes actionability Cohen's kappa over the complete eligible
final-side line universe of each verified diff. Frozen candidates and both
adjudicators' decisions are projected onto that independently derived universe;
unproposed lines count as jointly non-actionable, so candidate padding or silence
cannot choose the denominator. Admission separately computes
one-unit-per-scenario artifact-semantics kappa for defect-versus-clean verdicts.
It records both 2x2 marginal tables, rather than mixing clean scenarios with
label units. Severity-within-one-tier agreement is computed only where both
adjudicators marked a candidate actionable. Admission fails below 0.70, 0.70,
and 0.85 respectively. The publication receipt gate additionally requires at
least 150 scenarios, 125 defects, 25 clean controls, 30 P0/P1 gold labels, six
artifact-verified languages, ten repositories, 150 eligible line units, 25
unanimously actionable line units, and 25 unanimously rejected line units. Small draft receipts are valid intake
evidence but cannot pass the publication comparator or support a reliability
claim.

This packet does not cryptographically authenticate a human identity or prove
that human judgment is correct. It makes the judgment independently reviewable,
immutable, and bound to the exact bytes and admission receipt; blinded human
adjudication and adversarial review remain part of the trust boundary.

## Supported provenance

Corpus v1 supports immutable public GitHub pull-request, commit, and revert
artifacts; verified-clean controls additionally require pull-request provenance.
Pull-request provenance is limited to closed, merged PRs whose bounded,
exhaustive GitHub PR-commit list ends at the pinned reviewed source revision.
Live branch-tip head/base fields are deliberately not evidence because they can
move after merge. The exact pinned base/head comparison URL and downloaded bytes
remain hash-bound to the corpus; sources that cannot prove the merged-PR commit
relation must use commit or revert provenance. The earlier
placeholder `synthetic` provenance is rejected until the separately tracked
derived-artifact contract can bind the original artifact, deterministic
transformation, parameters, derived bytes, resulting tree, and natural-versus-
derived stratum. Reverse patches and seeded mutations must not masquerade as
upstream GitHub diffs.

## Matching contract

- Gold paths are canonical repository-relative paths.
- Gold lines are final/new-side context or added lines in the verified diff.
  Deletion-only lines cannot be gold anchors.
- Candidate severity may differ from gold severity by at most one tier.
- Same-path line delta zero is exact; line delta one through three is the
  intentional nearby-location tolerance.
- Lexical overlap thresholds are 0.25 for exact-location candidates and 0.35
  for nearby candidates.
- Evidenced semantic near-misses enter the human-resolution queue instead of
  being silently counted as matches.
- Matching maximizes cardinality first, then exactness/location cost, with
  deterministic locale-independent ordering.

The nearby tolerance applies to candidate findings, not to gold admission: gold
anchors remain verified. Matcher version, semantic decisions, evaluator
identity, thresholds, and fingerprint travel with scored evidence.

## Admission order

1. Freeze repository, base/head, source bytes, license identity, and hashes.
2. Establish that the defect exists in the reviewed artifact, or independently
   establish that the exact control diff is clean.
3. Keep oracle material out of the model-input packet.
4. Freeze the protocol-bound candidate universe, then obtain two complete
   independent blinded adjudications; reconcile disagreements over that same
   universe.
5. Pin the exact rubric and adjudication-protocol artifact hashes; freeze
   repository-grouped and canonical regression-category-family-grouped splits
   and sealed holdout membership. Free-text family aliases are rejected.
6. Place each source diff, oracle packet, rubric, and protocol under its declared
   digest name. Corpus JSON and oracle JSON must be emitted by
   `serializeReviewBenchCorpus` and `serializeReviewBenchOracleEvidence`; pretty
   JSON, duplicate keys, and malformed UTF-8 fail closed.
   Admission preflights every local artifact and requires its evidence times not
   to follow `admittedAt` before making any GitHub request,
   binds every declared language to at least one changed source-file path in the
   verified diff, enforces agreement floors, live-verifies public and oracle sources, then
   creates the no-clobber receipt outside every Git checkout. Its parent must
   already exist; admission captures and revalidates that parent's real path,
   device, and inode immediately before no-clobber publication. The receipt binds corpus,
   public-source verification, semantic evidence, oracle-source verification,
   rubric/protocol identities, and agreement metrics under separately versioned
   algorithms.
7. Only a separate reviewed publication change may copy the exact receipt and
   sanitized corpus subset into `docs/bench/`; CI independently re-verifies it.
   `corpus.json`, `source-artifacts/`, and `admission-receipt.json` must be all
   present or all absent; partial publication state fails CI.

Source admission proves public provenance, immutable bytes, license evidence,
gold-line grounding, and exact semantic-evidence binding. The oracle packet plus
blinded adjudication make label truth reviewable; they do not turn subjective
adjudication into cryptographic fact.

No model/provider execution, public leaderboard, default-provider change, or
release follows from this contract alone.
