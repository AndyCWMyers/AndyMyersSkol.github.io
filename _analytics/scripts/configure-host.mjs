import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const directory = join(homedir(), "Library/Application Support/AndysCommandCenter/WebsiteAnalytics");
const path = join(directory, "config.json");

async function configure() {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let config;
  try { config = JSON.parse(await readFile(path, "utf8")); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    config = { reportUrl: "https://www.andrewcwmyers.com/__analytics/report", readToken: randomBytes(32).toString("hex") };
    await writeFile(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  }
  await chmod(path, 0o600);
  if (!config.readToken || config.readToken.length < 32) throw new Error("Invalid local read token");
  const child = spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "secret", "put", "READ_TOKEN"], { stdio: ["pipe", "inherit", "inherit"] });
  child.stdin.end(config.readToken + "\n");
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`Wrangler exited ${code}`)));
  });
  console.log("Read token configured. Private host configuration is outside Git and Dropbox.");
}

await configure();
