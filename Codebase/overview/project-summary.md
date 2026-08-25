# Project Summary

The export describes Allybot as observed at commit `437115f19b84adcae3e42d1d5fa89ec8ecde34cc`. It contains 277 allowlisted source/document files, 6955 symbol rows, 927 import rows, 15728 call rows, 201 command rows, 119 service/plugin registrations, 372 test rows, and 15 dependency rows.

## Retrieval order

Read the project summary and tree first. Search the command/service/config tables next. Follow imports and calls to identify the smallest relevant source boundary. Read the corresponding snapshot files only after the relationship table provides a path.

## Evidence rule

Static relationships are marked with a confidence level. A high-confidence row has a resolvable local declaration or an explicit registration pattern. Low-confidence rows are hints that require source confirmation; they are not proof of runtime behavior.
