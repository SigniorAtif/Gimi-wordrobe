// Fails the build if the mock backend leaked into the release bundle (SPEC §0).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const dir = "dist";
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".js")) files.push(p);
  }
})(dir);
const leaks = files.filter((f) => readFileSync(f, "utf8").includes("__mock"));
if (leaks.length) {
  console.error(`check-no-mock: mock backend found in release bundle: ${leaks.join(", ")}`);
  process.exit(1);
}
console.log(`check-no-mock: ok (${files.length} js files)`);
