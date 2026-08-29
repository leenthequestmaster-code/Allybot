# Project Summary

The export describes Allybot as observed at commit `6c41a20077f0606454fa6117614cc2e485f48219`. It contains 279 allowlisted source/document files, 7059 symbol rows, 922 import rows, 15645 call rows, 186 command rows, 118 service/plugin registrations, 369 test rows, and 15 dependency rows.

## Retrieval order

Read the project summary and tree first. Search the command/service/config tables next. Follow imports and calls to identify the smallest relevant source boundary. Read the corresponding snapshot files only after the relationship table provides a path.

## Evidence rule

Static relationships are marked with a confidence level. A high-confidence row has a resolvable local declaration or an explicit registration pattern. Low-confidence rows are hints that require source confirmation; they are not proof of runtime behavior.
