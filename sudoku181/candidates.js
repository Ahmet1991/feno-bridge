function getCandidates(grid, r, c) {
  if (grid[r][c]) return [];
  const used = new Set();
  for (let i = 0; i < 9; i++) {
    if (grid[r][i]) used.add(grid[r][i]);
    if (grid[i][c]) used.add(grid[i][c]);
  }
  const br = Math.floor(r / 3) * 3;
  const bc = Math.floor(c / 3) * 3;
  for (let rr = br; rr < br + 3; rr++) {
    for (let cc = bc; cc < bc + 3; cc++) {
      if (grid[rr][cc]) used.add(grid[rr][cc]);
    }
  }
  return [1,2,3,4,5,6,7,8,9].filter(n => !used.has(n));
}

if (typeof window !== 'undefined') window.getCandidates = getCandidates;
if (typeof module !== 'undefined') module.exports = { getCandidates };
