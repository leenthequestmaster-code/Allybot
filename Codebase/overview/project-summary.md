# Project Summary

The export describes Allybot as observed at commit `b201c246b682667b5a02d0b4d062b75bc382e68a`. It contains 279 allowlisted source/document files, 7155 symbol rows, 925 import rows, 15880 call rows, 207 command rows, 118 service/plugin registrations, 375 test rows, and 15 dependency rows.

## Retrieval order

Read the project summary and tree first. Search the command/service/config tables next. Follow imports and calls to identify the smallest relevant source boundary. Read the corresponding snapshot files only after the relationship table provides a path.

## Evidence rule

Static relationships are marked with a confidence level. A high-confidence row has a resolvable local declaration or an explicit registration pattern. Low-confidence rows are hints that require source confirmation; they are not proof of runtime behavior.
