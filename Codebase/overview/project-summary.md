# Project Summary

The export describes Allybot as observed at commit `f7189bca0954752315a989336576a919df11cb4b`. It contains 257 allowlisted source/document files, 6300 symbol rows, 836 import rows, 14338 call rows, 190 command rows, 107 service/plugin registrations, 343 test rows, and 14 dependency rows.

## Retrieval order

Read the project summary and tree first. Search the command/service/config tables next. Follow imports and calls to identify the smallest relevant source boundary. Read the corresponding snapshot files only after the relationship table provides a path.

## Evidence rule

Static relationships are marked with a confidence level. A high-confidence row has a resolvable local declaration or an explicit registration pattern. Low-confidence rows are hints that require source confirmation; they are not proof of runtime behavior.
