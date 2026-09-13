# Project Summary

The export describes Allybot as observed at commit `6d7eaa92e0ebb1dfa34335155e9dcf9b59ebc6b8`. It contains 137 allowlisted source/document files, 5495 symbol rows, 703 import rows, 11961 call rows, 153 command rows, 120 service/plugin registrations, 282 test rows, and 14 dependency rows.

## Retrieval order

Read the project summary and tree first. Search the command/service/config tables next. Follow imports and calls to identify the smallest relevant source boundary. Read the corresponding snapshot files only after the relationship table provides a path.

## Evidence rule

Static relationships are marked with a confidence level. A high-confidence row has a resolvable local declaration or an explicit registration pattern. Low-confidence rows are hints that require source confirmation; they are not proof of runtime behavior.
