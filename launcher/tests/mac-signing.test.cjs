const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { macBuildIsSigned } = require("../scripts/mac-signing.cjs");

// The failure this exists to prevent: electron-builder signs nothing on a pull request, so
// verifying strictly there fails on every diff for a reason no diff can fix.
test("a pull request build is not expected to be signed", () => {
  assert.equal(macBuildIsSigned({ GITHUB_EVENT_NAME: "pull_request" }), false);
});

test("an operator who forces signing on a pull request still gets it verified", () => {
  assert.equal(
    macBuildIsSigned({ GITHUB_EVENT_NAME: "pull_request", CSC_FOR_PULL_REQUEST: "true" }),
    true,
  );
});

// Everything that can actually reach a user keeps the strict check. This is the half of the
// change that must never regress: an unsigned release is what the verification exists to catch.
for (const event of ["push", "release", "workflow_dispatch", "schedule"]) {
  test(`a ${event} build is verified`, () => {
    assert.equal(macBuildIsSigned({ GITHUB_EVENT_NAME: event }), true);
  });
}

test("a local build outside CI is verified", () => {
  assert.equal(macBuildIsSigned({}), true);
});

// Only the documented value forces signing; electron-builder's own message names "true". Any
// other spelling falls back to skipping, which is the direction that cannot turn CI red again.
test("a value other than \"true\" does not count as forcing signing on a pull request", () => {
  for (const value of ["1", "yes", "TRUE", "", "false"]) {
    assert.equal(
      macBuildIsSigned({ GITHUB_EVENT_NAME: "pull_request", CSC_FOR_PULL_REQUEST: value }),
      false,
      `CSC_FOR_PULL_REQUEST=${JSON.stringify(value)} must not be read as forcing signing`,
    );
  }
});

test("the packaging script gates codesign on this predicate and still validates the bundle", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "package.cjs"), "utf8");
  assert.match(source, /if \(macBuildIsSigned\(env\)\) \{\s*\n\s*runChecked\("codesign"/);
  // validateRuntimeBundle must stay outside the gate: it is what a pull request can actually
  // break, and it was unreachable on every pull request while codesign threw first.
  const gate = source.indexOf("if (macBuildIsSigned(env))");
  const validate = source.indexOf("validateRuntimeBundle(path.join(appBundle");
  assert.ok(gate !== -1 && validate !== -1 && validate > gate);
  // The if/else must be closed before validateRuntimeBundle, so the braces between them balance.
  const between = source.slice(gate, validate);
  const depth = between.split("{").length - between.split("}").length;
  assert.equal(depth, 0, "validateRuntimeBundle must not be inside the signing branch");
});
