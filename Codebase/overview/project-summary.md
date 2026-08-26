# Project Summary

The export describes Allybot as observed at commit `d4fd8f2df8d882e91816405def1930d3c2928af6`. It contains 277 allowlisted source/document files, 6973 symbol rows, 928 import rows, 15769 call rows, 204 command rows, 119 service/plugin registrations, 375 test rows, and 15 dependency rows.

## Retrieval order

Read the project summary and tree first. Search the command/service/config tables next. Follow imports and calls to identify the smallest relevant source boundary. Read the corresponding snapshot files only after the relationship table provides a path.

## Evidence rule

Static relationships are marked with a confidence level. A high-confidence row has a resolvable local declaration or an explicit registration pattern. Low-confidence rows are hints that require source confirmation; they are not proof of runtime behavior.
