// A barrel: see vitest.suites.config.ts. Nothing here but imports.
import "../jwt.test";
import "../appattest.test";
import "../identity-auth.test";
import "../provider-handoff.test";
// Not beside email-sender.test: that file mocks the SMTP client this one runs.
import "../email-smtp-wire.test";
