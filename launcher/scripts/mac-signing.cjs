/**
 * Whether a macOS build will carry a signature worth verifying.
 *
 * electron-builder refuses to sign a pull request build unless CSC_FOR_PULL_REQUEST is set. The
 * ad-hoc `--config.mac.identity=-` that package.cjs passes therefore never takes effect there, and
 * `codesign --verify --deep --strict` runs against an unsigned bundle and fails - on every diff,
 * for a reason no diff can fix.
 *
 * The exemption is deliberately narrow: only a pull request build, and only while the operator has
 * not asked for signing anyway. A push, tag, release or local build still verifies strictly, which
 * is where an unsigned artifact would actually reach a user.
 */
function macBuildIsSigned(env = process.env) {
  if (env.CSC_FOR_PULL_REQUEST === "true") return true;
  return env.GITHUB_EVENT_NAME !== "pull_request";
}

module.exports = { macBuildIsSigned };
