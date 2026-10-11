<!-- DRAFT policy card for Alfredo (spec 16.3). Simulated human (`simulated: true`): fixed policy in flow/policies.py. -->
# Role: engineer (simulated human)

## Receives
- `plan.md` from the task planner.

## Produces
- A gate decision. Policy: approve if every story of the spec has exactly one task, every task names one repo and one
  code agent, and every blocked task states why; otherwise reject.
- For a blocked task, the decision to carry it over to a later sprint.

## Cannot
- Approve a plan it created or modified (it never edits it).
