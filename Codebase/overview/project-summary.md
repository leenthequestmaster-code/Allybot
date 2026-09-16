# Project Summary

The export describes Allybot as observed at commit `a51fcd9dd13d917d403c4eb1516bff077e03b6f0`. It contains 137 allowlisted source/document files, 5544 symbol rows, 705 import rows, 12034 call rows, 153 command rows, 120 service/plugin registrations, 285 test rows, and 14 dependency rows.

## Retrieval order

Read the project summary and tree first. Search the command/service/config tables next. Follow imports and calls to identify the smallest relevant source boundary. Read the corresponding snapshot files only after the relationship table provides a path.

## Evidence rule

Static relationships are marked with a confidence level. A high-confidence row has a resolvable local declaration or an explicit registration pattern. Low-confidence rows are hints that require source confirmation; they are not proof of runtime behavior.
