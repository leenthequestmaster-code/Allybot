# Known Limitations

Static analysis cannot prove dynamic imports, reflection, runtime dependency injection, generated code, or every indirect call. Unresolved and low-confidence rows are retained as explicit uncertainty rather than guessed relationships. Runtime behavior still requires tests, source review, and deployment evidence.
