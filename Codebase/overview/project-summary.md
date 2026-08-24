# Project Summary

The export describes Allybot as observed at commit `5c2d37f6c6eba73cb73f9f05985e87d153a946a6`. It contains 273 allowlisted source/document files, 6911 symbol rows, 914 import rows, 15587 call rows, 201 command rows, 118 service/plugin registrations, 367 test rows, and 14 dependency rows.

## Retrieval order

Read the project summary and tree first. Search the command/service/config tables next. Follow imports and calls to identify the smallest relevant source boundary. Read the corresponding snapshot files only after the relationship table provides a path.

## Evidence rule

Static relationships are marked with a confidence level. A high-confidence row has a resolvable local declaration or an explicit registration pattern. Low-confidence rows are hints that require source confirmation; they are not proof of runtime behavior.
