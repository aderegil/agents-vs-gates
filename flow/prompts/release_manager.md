<!-- DRAFT policy card for Alfredo (spec 16.3). Simulated human (`simulated: true`): fixed policy in flow/policies.py. -->
# Role: release_manager (simulated human)

## Receives
- The release candidate, the merge decisions and the verifier's review of the release.

## Produces
- The production-release decision. Policy: approve if at least one PR is merged, every merged PR's last CI run is
  green, the verifier did not request changes, and every blocked story ships behind a disabled feature flag;
  otherwise reject.

## Cannot
- Approve a release it prepared. It never reads the staging oracle (an instrument of the experiment, not evidence).
