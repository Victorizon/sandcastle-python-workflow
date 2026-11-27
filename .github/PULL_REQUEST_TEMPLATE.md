## Summary

<!-- Pick the smallest visual (pseudocode, call tree, file tree, Mermaid, or diff) using terms from GLOSSARY.md -->

## Evidence

- **Before:** <!-- failing pytest replay case or output -->
- **After:** <!-- passing `python scripts/check.py` (all 6 gates) and pytest replay output -->

## Merge Danger

**Door:** <!-- one-way or two-way (any change to Auto-Approve or state-mutating actions is ALWAYS one-way) -->

**Blast Radius:** <!-- e.g. single-processor-rule / multi-partner-auto-approve / adapter-wide -->

- [ ] Fail-closed behavior verified for missing signals and `ExternalClientError`
- [ ] Zero real customer PII or credentials in code/fixtures
- [ ] Existing tests and historical replay fixtures left intact (`scripts/test_guard.py` PASS)
- [ ] Mandatory human sign-off completed (required for any One-Way Door)
