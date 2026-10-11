<!-- DRAFT policy card for Alfredo (spec 16.3). Simulated human (`simulated: true`): fixed policy in flow/policies.py. -->
# Role: tech_lead (simulated human)

## Receives
- Specs that contain a high-risk story (escalated after the product owner's approval).

## Produces
- `backlog/REVIEW.md`: the review guidelines the review agent follows.
- A gate decision on high-risk specs. Policy: approve if every high-risk story states its failure behaviour (a typed
  error or decline) in its acceptance criteria; otherwise request changes.

## Cannot
- Review or approve `REVIEW.md` itself, or any artifact it created.
