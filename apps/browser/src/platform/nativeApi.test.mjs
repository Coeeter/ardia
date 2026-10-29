import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the JS bundle and the native build declare the same API version", () => {
  const js = read("./nativeApi.ts").match(/export const NATIVE_API_VERSION = (\d+);/)?.[1];
  const native = read("../../../../packages/shell/ios/AppModule.swift").match(/Constant\("apiVersion"\) \{ \(\) -> Int in (\d+) \}/)?.[1];
  assert.ok(js && native, "both declarations found");
  assert.equal(js, native);
});

const packagesDir = new URL("../../../../packages/", import.meta.url);
const nativePackages = readdirSync(packagesDir).filter((name) => existsSync(new URL(`${name}/expo-module.config.json`, packagesDir)));

const declaredModules = () =>
  nativePackages.flatMap((pkg) => {
    const ios = new URL(`${pkg}/ios/`, packagesDir);
    return readdirSync(ios, { recursive: true })
      .filter((file) => file.endsWith(".swift"))
      .flatMap((file) => {
        const source = readFileSync(new URL(file, ios), "utf8");
        const domain = source.match(/CallTable\(domain: "([a-zA-Z]+)"/)?.[1];
        return [...source.matchAll(/^ {4}Name\((?:"([^"]+)"|Self\.calls\.moduleName)\)/gm)].map(([, literal]) => ({
          where: `${pkg}/ios/${file}`,
          name: literal ?? `Ardia${domain[0].toUpperCase()}${domain.slice(1)}`,
        }));
      });
  });

const duplicates = (entries) => {
  const seen = new Map();
  for (const { key, where } of entries) seen.set(key, new Set([...(seen.get(key) ?? []), where]));
  return [...seen].filter(([, places]) => places.size > 1).map(([key, places]) => `${key}: ${[...places].join(", ")}`);
};

test("no two Expo modules register the same name, so neither shadows the other", () => {
  const modules = declaredModules();
  assert.ok(modules.some((m) => m.name === "ArdiaShell") && modules.some((m) => m.name === "ArdiaWindows"), "found the shell and ArdiaCore modules");
  assert.deepEqual(duplicates(modules.map(({ name, where }) => ({ key: name, where }))), []);
});

test("no two packages list the same Swift module class, so the generated modules provider can name each one", () => {
  const classes = nativePackages.flatMap((pkg) => {
    const config = JSON.parse(readFileSync(new URL(`${pkg}/expo-module.config.json`, packagesDir), "utf8"));
    return (config.apple?.modules ?? []).map((name) => ({ key: name, where: pkg }));
  });
  assert.deepEqual(duplicates(classes), []);
});
