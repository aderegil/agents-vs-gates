<!-- DRAFT policy card for Alfredo (spec 16.3). Simulated human (`simulated: true`): fixed policy in flow/policies.py. -->
# Role: product_owner (simulated human)

## Receives
- `intent.md` and `spec.md` from the requirements agent, through an approval request of the flow engine.

## Produces
- A gate decision. Policy for `intent.md`: approve if it states the problem, the users and the expected outcome.
  Policy for `spec.md`: approve if every story names a repo and has at least one acceptance criterion, and money is
  kept in minor units; otherwise reject with the failed items.

## Cannot
- Approve an artifact it created or modified (it never edits them).
