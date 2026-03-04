/* scripts/ensure-chrome.cjs */
const fs = require("fs");
const { execSync } = require("child_process");

function log(...args) {
  console.log("[ensure-chrome]", ...args);
}

(async () => {
  let puppeteer;
  try {
    puppeteer = require("puppeteer");
  } catch (e) {
    console.error("[ensure-chrome] puppeteer not found. Did npm install run?");
    process.exit(1);
  }

  const ep = typeof puppeteer.executablePath === "function" ? puppeteer.executablePath() : "";
  const exists = ep && fs.existsSync(ep);

  log("PUPPETEER_CACHE_DIR =", process.env.PUPPETEER_CACHE_DIR || "(not set)");
  log("PUPPETEER_EXECUTABLE_PATH =", process.env.PUPPETEER_EXECUTABLE_PATH || "(not set)");
  log("puppeteer.executablePath() =", ep || "(empty)");
  log("exists =", !!exists);

  if (exists) return;

  // Fallback: force install chrome at runtime (cold start) if build cache didn't bring it.
  // Use a local cache dir inside the project to increase chance it exists at runtime.
  const cacheDir = process.env.PUPPETEER_CACHE_DIR || "./.cache/puppeteer";
  log("Installing Chrome via Puppeteer CLI. cacheDir =", cacheDir);

  execSync(`PUPPETEER_CACHE_DIR="${cacheDir}" npx puppeteer browsers install chrome`, {
    stdio: "inherit",
    env: { ...process.env, PUPPETEER_CACHE_DIR: cacheDir },
  });

  const ep2 = typeof puppeteer.executablePath === "function" ? puppeteer.executablePath() : "";
  const exists2 = ep2 && fs.existsSync(ep2);
  log("After install executablePath =", ep2 || "(empty)");
  log("After install exists =", !!exists2);

  if (!exists2) {
    console.error("[ensure-chrome] Chrome still not found after install.");
    process.exit(1);
  }
})();
