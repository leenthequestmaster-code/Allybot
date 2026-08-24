# Project Summary

The export describes Allybot as observed at commit `a768f124277d5ce311e9642412277be29dd76513`. It contains 273 allowlisted source/document files, 6915 symbol rows, 914 import rows, 15592 call rows, 201 command rows, 118 service/plugin registrations, 368 test rows, and 14 dependency rows.

## Retrieval order

Read the project summary and tree first. Search the command/service/config tables next. Follow imports and calls to identify the smallest relevant source boundary. Read the corresponding snapshot files only after the relationship table provides a path.

## Evidence rule

Static relationships are marked with a confidence level. A high-confidence row has a resolvable local declaration or an explicit registration pattern. Low-confidence rows are hints that require source confirmation; they are not proof of runtime behavior.
