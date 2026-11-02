// Validates data/districts.json: every entry must have lat < 0 and lon > 0.
// Usage: npm run validate:districts. Exits 1 listing offenders.
const DISTRICTS = require('../data/districts.json');

let bad = 0;
let checked = 0;
for (const [name, e] of Object.entries(DISTRICTS.districts)) {
  checked++;
  if (typeof e.lat !== 'number' || typeof e.lon !== 'number' || !(e.lat < 0) || !(e.lon > 0)) {
    console.log(`FAIL ${name}: lat=${e.lat} lon=${e.lon}`);
    bad++;
  }
}
const d = DISTRICTS.default;
if (typeof d.lat !== 'number' || typeof d.lon !== 'number' || !(d.lat < 0) || !(d.lon > 0)) {
  console.log(`FAIL default: lat=${d.lat} lon=${d.lon}`);
  bad++;
}

if (bad > 0) {
  console.log(`${bad} of ${checked} district entries invalid (missing or out-of-range coords)`);
  process.exit(1);
}
console.log(`OK: ${checked} districts + default, all lat<0 lon>0`);
