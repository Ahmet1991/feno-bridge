const test=require('node:test'),assert=require('node:assert/strict');
const {acceptanceExpectations}=require('../../scripts/prepare-pc2-acceptance.cjs');
test('full access acceptance expects all local drive roots and installed applications',()=>{
  const full=acceptanceExpectations('full'),limited=acceptanceExpectations('selective');
  assert.match(full.expectedGrant,/all 11 permissions/);
  assert.match(full.outsideSelectedProject,/allow/);
  assert.match(full.nonAllowlistedApplication,/allow/);
  assert.equal(limited.outsideSelectedProject,'deny');
  assert.equal(limited.nonAllowlistedApplication,'deny');
  assert.equal(full.helperIntegrity,limited.helperIntegrity);
  assert.equal(full.devCoordinationLease,limited.devCoordinationLease);
  assert.throws(()=>acceptanceExpectations('wrong'));
});
