# Project Summary

The export describes Allybot as observed at commit `167676e1a259e469a778fd014c70697e1e2ecff7`. It contains 251 allowlisted source/document files, 6008 symbol rows, 829 import rows, 13600 call rows, 183 command rows, 119 service/plugin registrations, 322 test rows, and 14 dependency rows.

## Retrieval order

Read the project summary and tree first. Search the command/service/config tables next. Follow imports and calls to identify the smallest relevant source boundary. Read the corresponding snapshot files only after the relationship table provides a path.

## Evidence rule

Static relationships are marked with a confidence level. A high-confidence row has a resolvable local declaration or an explicit registration pattern. Low-confidence rows are hints that require source confirmation; they are not proof of runtime behavior.
