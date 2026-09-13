# Project Summary

The export describes Allybot as observed at commit `9be74845a6018492cb19a70846d91b5a5fa13f9e`. It contains 137 allowlisted source/document files, 5492 symbol rows, 703 import rows, 11949 call rows, 153 command rows, 120 service/plugin registrations, 282 test rows, and 14 dependency rows.

## Retrieval order

Read the project summary and tree first. Search the command/service/config tables next. Follow imports and calls to identify the smallest relevant source boundary. Read the corresponding snapshot files only after the relationship table provides a path.

## Evidence rule

Static relationships are marked with a confidence level. A high-confidence row has a resolvable local declaration or an explicit registration pattern. Low-confidence rows are hints that require source confirmation; they are not proof of runtime behavior.
