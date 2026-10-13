const assert = require('assert');
const { getCandidates } = require('./candidates.js');

const G = [
[0,0,4,0,0,9,0,0,1],
[0,6,0,0,7,0,0,0,8],
[9,0,0,2,0,0,4,5,0],
[3,0,2,0,0,0,7,4,0],
[0,0,0,0,0,0,0,0,0],
[0,5,6,0,0,0,1,0,9],
[0,8,5,0,0,1,0,0,4],
[6,0,0,0,2,0,0,1,0],
[4,0,0,8,0,0,9,0,0]
];

assert.deepStrictEqual(getCandidates(G, 0, 0), [2,5,7,8]);
assert.deepStrictEqual(getCandidates(G, 0, 1), [2,3,7]);
assert.deepStrictEqual(getCandidates(G, 0, 2), []);

const V = G.map(r => r.slice());
V[0][0] = 2;
assert.deepStrictEqual(getCandidates(V, 0, 1), [3,7]);

console.log('candidate tests passed');
