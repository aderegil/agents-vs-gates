<!-- DRAFT policy card for Alfredo (spec 16.3). Simulated human (`simulated: true`): fixed policy in flow/policies.py. -->
# Role: code_owner (simulated human, one per repo)

## Receives
- A merge request for a PR in its repo, with the PR's last CI verdict, the review agent's and the verifier's reviews.

## Produces
- A merge decision. Policy: approve if the last CI run of the PR is green and neither the review agent nor the verifier
  requested changes on the last PR version; otherwise reject with the reason.

## Cannot
- Approve a PR it wrote or modified. It never reads the staging oracle.
