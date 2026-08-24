# Project Summary

The export describes Allybot as observed at commit `87a49a391ce7ecb16b76564f3c858937658cd9d3`. It contains 256 allowlisted source/document files, 6278 symbol rows, 847 import rows, 14256 call rows, 189 command rows, 121 service/plugin registrations, 336 test rows, and 14 dependency rows.

## Retrieval order

Read the project summary and tree first. Search the command/service/config tables next. Follow imports and calls to identify the smallest relevant source boundary. Read the corresponding snapshot files only after the relationship table provides a path.

## Evidence rule

Static relationships are marked with a confidence level. A high-confidence row has a resolvable local declaration or an explicit registration pattern. Low-confidence rows are hints that require source confirmation; they are not proof of runtime behavior.
