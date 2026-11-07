---
"apps": patch
---

A `jsonSchema()` field nested in `object()`, `array()` or `.optional()` is listed with its
document instead of `{}`, so `search` and `describe` show agents the type that its call validates
against. A nested document with `$ref`, `$defs` or an identifier is still listed as `{}`.
