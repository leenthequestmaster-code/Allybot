# Project Summary

The export describes Allybot as observed at commit `58e291461d74229d19cbc907b5145dbd19593108`. It contains 191 allowlisted source/document files, 4976 symbol rows, 642 import rows, 10600 call rows, 152 command rows, 96 service/plugin registrations, 237 test rows, and 14 dependency rows.

## Retrieval order

Read the project summary and tree first. Search the command/service/config tables next. Follow imports and calls to identify the smallest relevant source boundary. Read the corresponding snapshot files only after the relationship table provides a path.

## Evidence rule

Static relationships are marked with a confidence level. A high-confidence row has a resolvable local declaration or an explicit registration pattern. Low-confidence rows are hints that require source confirmation; they are not proof of runtime behavior.
