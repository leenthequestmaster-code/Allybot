# Project Summary

The export describes Allybot as observed at commit `7e1c85d843ce5163311707caa8ba2c0d6e284cc3`. It contains 142 allowlisted source/document files, 5727 symbol rows, 734 import rows, 12357 call rows, 153 command rows, 120 service/plugin registrations, 287 test rows, and 15 dependency rows.

## Retrieval order

Read the project summary and tree first. Search the command/service/config tables next. Follow imports and calls to identify the smallest relevant source boundary. Read the corresponding snapshot files only after the relationship table provides a path.

## Evidence rule

Static relationships are marked with a confidence level. A high-confidence row has a resolvable local declaration or an explicit registration pattern. Low-confidence rows are hints that require source confirmation; they are not proof of runtime behavior.
