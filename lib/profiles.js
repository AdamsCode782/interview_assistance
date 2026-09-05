import { readFileSync } from "node:fs";

const loadJson = name => JSON.parse(readFileSync(new URL(`../profiles/${name}`, import.meta.url), "utf8"));

export function loadProfiles() {
  return {
    shared: loadJson("shared.json"),
    softwareEngineering: loadJson("software-engineering.json"),
    aiData: loadJson("ai-data.json"),
    devopsPlatform: loadJson("devops-platform.json"),
    boundaries: loadJson("boundaries.json")
  };
}
