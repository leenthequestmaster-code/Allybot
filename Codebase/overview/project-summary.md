# Project Summary

The export describes Allybot as observed at commit `529e395b2a4e392c77bb7a5e3bce1eb1fe27a88e`. It contains 256 allowlisted source/document files, 6292 symbol rows, 847 import rows, 14301 call rows, 189 command rows, 121 service/plugin registrations, 339 test rows, and 14 dependency rows.

## Retrieval order

Read the project summary and tree first. Search the command/service/config tables next. Follow imports and calls to identify the smallest relevant source boundary. Read the corresponding snapshot files only after the relationship table provides a path.

## Evidence rule

Static relationships are marked with a confidence level. A high-confidence row has a resolvable local declaration or an explicit registration pattern. Low-confidence rows are hints that require source confirmation; they are not proof of runtime behavior.
