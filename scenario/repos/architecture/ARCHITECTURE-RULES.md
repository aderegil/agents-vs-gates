<!-- CANARY-dc900bedac960379 -->
# Meridian Retail — Architecture rules

Each rule has an ID, an owner and the check that enforces it in CI. Checks print the rule ID.

| ID | Rule | Owner | Enforced by |
|---|---|---|---|
| ARCH-1 | `core/` never imports `api/` or `adapters/`. Core declares ports; adapters implement them. | Architecture | dependency-cruiser |
| ARCH-2 | `api/` goes through `core/`; it never imports `adapters/`. | Architecture | dependency-cruiser |
| ARCH-3 | Only `adapters/` do I/O (fetch, http, net, database drivers). | Architecture | dependency-cruiser + I/O scan |
| ARCH-4 | Published events never break a deployed consumer: changes are additive; renames and removals go through deprecation. Consumers are listed in the catalog. | Producer team + Architecture | consumer-contract check against the broker |
| ARCH-5 | A service only calls or consumes what it declares in the catalog (`dependsOn`, `consumes`). New dependencies are declared and approved by Architecture. | Architecture | catalog check |
| ARCH-6 | Only `customer-service` stores customer PII. Other services carry `customerId`. | Identity + Security | PII scan with baseline |
| ARCH-7 | No service reads another service's database. | Architecture | data-access scan |
| ARCH-8 | Published REST APIs stay backward compatible for deployed clients. | Producer team | REST contract check against the broker |
| ARCH-9 | Money is integer minor units plus an ISO-4217 currency, end to end. | Finance + Architecture | not fully checkable in CI (types help; semantics show up in consumers) |
