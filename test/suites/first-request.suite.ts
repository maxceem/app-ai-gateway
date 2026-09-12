// A barrel: see vitest.suites.config.ts. Nothing here but imports.
// Alone deliberately: these tests walk the test organization from having no
// applications at all to having served traffic, so a file that creates an
// application in that organization beside them makes the first of them fail.
import "../admin-first-request.test";
