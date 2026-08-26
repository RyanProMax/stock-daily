import assert from "node:assert/strict";
import test from "node:test";
import {
  auditReportSources,
  isPublicAddress,
  openExternalSource,
} from "../scripts/daily-source-audit.mjs";
import { fixtureInput, fixtureReport } from "./daily-v10-fixture.mjs";

test("source audit opens every unique external evidence URL", async () => {
  const report = fixtureReport(fixtureInput());
  const visited = [];
  const result = await auditReportSources(report, {
    opener: async (source) => {
      visited.push(source);
      return { source, status: 200, finalUrl: source };
    },
  });
  assert.equal(result.status, "audited");
  assert.equal(result.sourceCount, 5);
  assert.equal(new Set(visited).size, 5);
  assert.ok(visited.every((source) => source.startsWith("https://")));
});

test("source audit rejects an external URL that cannot be opened", async () => {
  const report = fixtureReport(fixtureInput());
  await assert.rejects(
    () =>
      auditReportSources(report, {
        opener: async (source) => {
          throw new Error(`unreachable ${source}`);
        },
      }),
    /unreachable/,
  );
});

test("source opener validates and pins every HTTPS redirect destination", async () => {
  const requested = [];
  const resolved = [];
  const result = await openExternalSource(
    "https://publisher.example.com/article",
    {
      resolver: async (hostname) => {
        resolved.push(hostname);
        return [{ address: "93.184.216.34", family: 4 }];
      },
      requester: async (url, destination) => {
        requested.push({ url, destination });
        return requested.length === 1
          ? { status: 302, location: "https://cdn.example.net/story" }
          : { status: 200 };
      },
    },
  );
  assert.equal(result.status, 200);
  assert.equal(result.finalUrl, "https://cdn.example.net/story");
  assert.deepEqual(resolved, ["publisher.example.com", "cdn.example.net"]);
  assert.equal(requested.length, 2);
  assert.ok(
    requested.every(
      ({ destination }) => destination.address === "93.184.216.34",
    ),
  );
});

test("default opener pins public DNS and the verified source address", async () => {
  const calls = [];
  const result = await openExternalSource(
    "https://publisher.example.com/article",
    {
      curlPath: "/mock/curl",
      runner: async (_binary, args) => {
        calls.push(args);
        if (args.includes("Accept: application/dns-json")) {
          return {
            stdout: JSON.stringify({
              Status: 0,
              Answer: [
                {
                  type: 1,
                  data: "93.184.216.34",
                },
              ],
            }),
          };
        }
        return { stdout: "200\t" };
      },
    },
  );
  assert.equal(result.status, 200);
  assert.ok(
    calls[0].includes("cloudflare-dns.com:443:1.1.1.1:443"),
  );
  assert.ok(
    calls[1].includes("publisher.example.com:443:93.184.216.34:443"),
  );
  assert.ok(calls[1].includes("Host: publisher.example.com:443"));
  assert.equal(calls[1].includes("--location"), false);
});

test("source opener blocks private initial and DNS destinations", async () => {
  assert.equal(isPublicAddress("93.184.216.34"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  for (const address of [
    "127.0.0.1",
    "10.0.0.4",
    "169.254.169.254",
    "::1",
    "fd00::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }

  await assert.rejects(
    () => openExternalSource("https://127.0.0.1/private"),
    /禁止访问本机或内网地址/,
  );
  let requested = false;
  await assert.rejects(
    () =>
      openExternalSource("https://publisher.example.com/article", {
        resolver: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.4", family: 4 },
        ],
        requester: async () => {
          requested = true;
          return { status: 200 };
        },
      }),
    /禁止访问本机或内网地址/,
  );
  assert.equal(requested, false);
});

test("source opener blocks redirects to metadata services", async () => {
  let requestCount = 0;
  await assert.rejects(
    () =>
      openExternalSource("https://publisher.example.com/article", {
        resolver: async () => [{ address: "93.184.216.34", family: 4 }],
        requester: async () => {
          requestCount += 1;
          return {
            status: 302,
            location: "https://169.254.169.254/latest/meta-data/",
          };
        },
      }),
    /禁止访问本机或内网地址/,
  );
  assert.equal(requestCount, 1);
});
