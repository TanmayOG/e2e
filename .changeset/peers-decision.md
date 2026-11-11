---
"@e2e-dev/decision": patch
---

`decisionFilter()` counts a test as touched when a setup file that saves one of its peers' sessions changed, as it does for the test's own session.
