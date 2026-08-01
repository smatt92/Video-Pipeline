# Timing fixtures

`documented-shape.json` is **not a captured response.** It is hand-built from the vendor's
documentation of `POST /v1/text-to-speech/{voice_id}/with-timestamps`, because this
environment cannot reach the host to capture a real one.

That distinction is the whole point of this directory existing separately from the tests.
The converter is proven correct *against this shape*. Whether this shape is the shape the
vendor actually returns is unproven, and it is the single assumption most likely to be
wrong — see `docs/decisions/0008-what-is-unverified.md`.

To replace it with a real one, run the command in 0008 §7 and overwrite this file. The
tests should pass unchanged. If they do not, the converter was written against a fiction
and the test that fails names which part.
