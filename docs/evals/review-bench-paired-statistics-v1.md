# Review Bench paired statistics v1

This document freezes the internal promotion analysis implemented by
`review-bench-paired-analysis/v1`. Changing an endpoint, margin, interval,
sample-size rule, safety gate, or planned-look rule requires a new version and a
fresh sealed-holdout confirmation.

## Proof boundary

The analysis can support one internal role recommendation for the exact corpus,
target fingerprints, matcher fingerprints, adjudication protocol, and evidence
hashes in its input. It cannot support a public precision percentage,
CodeRabbit parity, universal model quality, arbitrary-repository performance,
production readiness, release readiness, or customer readiness.

The input contains opaque target and matcher fingerprints, but no model or
provider names. It also contains the exact sealed cohort roster and a
recomputed canonical cohort-manifest SHA-256. The cohort assigns one contiguous
analysis order, and every planned look must use only that frozen roster's exact
prefix; an outcome-selected subset or a new look-specific cohort cannot stand
in for the registered cohort. Each observation must bind a completed adjudication receipt
whose reviewers were blinded to provider identity and whose semantic near-miss
queue is empty.

## Unit of analysis

Observations are unique by repository, pull request, immutable head, and bug
family. The analyzer rejects that duplicate identity even if observation or run
identifiers differ. It then clusters all admitted bug-family observations for
the same repository, pull request, and head into one PR unit. All members of a
cluster must have the same language and artifact semantics.

Pooled-finding metrics are descriptive. Promotion uses only equally weighted
macro-PR endpoints, preventing one PR with many correlated findings from
dominating the decision.

## Endpoints

For each PR, candidate and baseline precision are defined as `1 - false
discovery rate`:

```text
precision = 1 - FP / max(1, TP + FP)
```

The zero-output precision value is therefore one. Precision cannot reward
silence by itself because recall is co-primary.

Recall is `TP / (TP + FN)`. Verified-clean controls have no gold defects, so
their PR-level recall is undefined and excluded from recall macro averages,
recall bootstrap samples, and recall power counts. They remain fully included
in precision, false-positive, and safety analysis. Candidate and baseline must
bind the same positive gold-label count on every defect observation.

The co-primary hypotheses are:

```text
H0 precision: candidate - baseline <= -0.05
H1 precision: candidate - baseline >  -0.05

H0 recall:    candidate - baseline <= -0.05
H1 recall:    candidate - baseline >  -0.05
```

Both strict lower bounds must exceed `-0.05`. The candidate macro-PR precision
lower bound must also be at least `0.80`. Because promotion requires both
co-primary noninferiority tests to pass, the gate uses an intersection-union
test at one-sided alpha `0.025`; it does not select a favorable confidence bin.

## Intervals and strata

`stratified-paired-pr-cluster-percentile/v1` resamples PR clusters with
replacement inside each observed repository/language stratum while preserving
each stratum's size. Candidate and baseline values remain paired. A frozen
integer seed, at least 1,000 resamples, and the exact input hash make the output
reproducible. The reported lower and upper limits are the 2.5th and 97.5th
percentiles; promotion uses the lower limit.

Repository and language are required canonical fields. The frozen expected
strata must cover at least ten repositories and six languages, and every
repository/language stratum must contain at least two distinct total PR-head
clusters and at least two defect PR-head clusters. The endpoint-specific floor
prevents clean controls from masking a singleton recall stratum and creating a
mechanically degenerate confidence bound.
At the final look, the immutable `bootstrap_stratum_support` gate separately
requires at least four total and four defect PR-head clusters in every observed
stratum. Underfilled final strata remain analyzable but return
`insufficient_evidence`; interim looks retain the two-cluster data-quality
floor because their prefixes are not promotion evidence.
The analyzer fails closed on absent, unexpected, or underfilled strata rather
than pooling an unstratified record.

## Power and planned looks

The separately frozen 30-PR variance pilot supplies paired PR standard
deviations for both endpoints. Each powered size is:

```text
n = ceil((((1.96 + 0.842) * paired_PR_SD) / 0.05) ^ 2)
```

The final paired sample must contain at least
`max(150, n_precision, n_recall)` unique PR heads. Because clean controls do not
carry recall information, defect PR heads must separately reach `n_recall` (and
the Corpus v1 floor of 125, whichever is larger). A zero variance-pilot SD can
therefore never collapse recall proof to one defect. Promotion additionally
requires at least 75 verified-clean PR controls; this floor is independent of
the powered defect count.

The preregistered 50% and 75% looks consume the exact ordered prefix of the one
frozen final cohort and are data-quality, assumption, and futility checks only.
Prefix completion is measured in sealed scenario observations; power remains
measured in unique PR-head clusters, so multiple bug families on one PR cannot
inflate the powered sample.
They can return `interim_continue`, `stop_for_futility`,
`stop_for_safety`, or `insufficient_evidence`; they cannot return `promote`.
The final look must contain every observation in the frozen cohort; a strict
prefix labeled `final` is rejected before analysis. Only that complete final
look can promote. An interim macro endpoint at least ten
percentage points behind baseline triggers the preregistered futility stop.

This is `final-only-obf-data-quality-looks/v1`: it deliberately does not spend
alpha on early efficacy. Any future early-promotion design requires a new
contract, a frozen validated Lan-DeMets/O'Brien-Fleming spending schedule,
simulation coverage, and independent statistical review.

## Fail-closed gates

Malformed or unknown fields, non-finite or inconsistent counts, duplicate
observation/scenario/PR identities, aggregate safe-integer overflow, a missing
or hash-mismatched sealed-cohort member, incomplete or unblinded adjudication,
unresolved near misses, missing strata, mismatched gold-label denominators, and
unbound fingerprints are rejected before analysis.

A result cannot promote when the candidate has any acceptance-set secret
finding, schema failure, duplicate-policy violation, or P0/P1 false negative.
Baseline secret, schema, or duplicate failures also invalidate the paired
evidence rather than making the comparison arm artificially weak. Those events
produce an immediate terminal `stop_for_safety`, including before the first
planned sample look. Insufficient power returns `insufficient_evidence`; a
powered final sample that fails a quality bound returns `do_not_promote`.

## Immutable output

The result records:

- corpus, sealed-cohort manifest, target, matcher, and adjudication bindings;
- hypotheses, margins, confidence level, multiplicity rule, alpha-spending
  version, bootstrap method, resamples, and seed;
- raw observation, unique-PR, defect-PR, clean-control, pilot, and powered sample
  counts;
- pooled-finding and macro-PR metrics;
- candidate absolute and paired-difference intervals;
- every gate and one terminal decision;
- a canonical input SHA-256 and an analysis SHA-256 over the complete result
  excluding only the result hash itself.

The statistics module performs no file I/O, provider calls, GitHub posting,
configuration mutation, worker/daemon work, or public-confidence changes.
