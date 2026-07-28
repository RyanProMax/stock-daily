#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import { basename, resolve } from "node:path";

const repositoryRoot = execFileSync(
  "git",
  ["rev-parse", "--show-toplevel"],
  { encoding: "utf8" },
).trim();

const candidateOutput = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: repositoryRoot },
);
const candidatePaths = candidateOutput
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const issues = [];
const allowedEnvironmentFiles = new Set([
  ".env.example",
  ".env.sample",
  ".dev.vars.example",
]);
const sensitiveFileNames = [
  /^\.env(?:\.|$)/i,
  /^\.dev\.vars(?:\.|$)/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^id_(?:rsa|ed25519)$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore|mobileprovision)$/i,
];

const macHomePattern = new RegExp(
  ["/", "Users", "/", "[A-Za-z0-9._-]+", "/"].join(""),
);
const linuxHomePattern = new RegExp(
  ["/", "home", "/", "[A-Za-z0-9._-]+", "/"].join(""),
);
const windowsHomePattern = new RegExp(
  ["[A-Za-z]:", "\\\\", "Users", "\\\\", "[^\\\\\\s]+", "\\\\"].join(""),
  "i",
);
const embeddedCredentialPattern = /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@/i;
const cloudflareAccountPattern =
  /\bCLOUDFLARE_ACCOUNT_ID\s*=\s*["']?[a-f0-9]{32}\b/i;
const credentialAssignmentPattern =
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|private[_-]?key)\s*[:=]\s*["'`]?[A-Za-z0-9_./+=-]{8,}/i;
const privateKeyPattern =
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/;
const emailPattern =
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

function addIssue(path, line, rule) {
  issues.push(`${path}:${line} ${rule}`);
}

function inspectText(path, text) {
  const lines = text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (
      macHomePattern.test(line) ||
      linuxHomePattern.test(line) ||
      windowsHomePattern.test(line)
    ) {
      addIssue(path, lineNumber, "contains a user-specific home path");
    }
    if (embeddedCredentialPattern.test(line)) {
      addIssue(path, lineNumber, "contains credentials embedded in a URL");
    }
    if (cloudflareAccountPattern.test(line)) {
      addIssue(path, lineNumber, "hardcodes a Cloudflare account identifier");
    }
    if (credentialAssignmentPattern.test(line)) {
      addIssue(path, lineNumber, "looks like a hardcoded credential");
    }
    if (privateKeyPattern.test(line)) {
      addIssue(path, lineNumber, "contains a private-key header");
    }

    const email = line.match(emailPattern)?.[0]?.toLowerCase();
    if (
      email &&
      !email.endsWith("@users.noreply.github.com") &&
      !email.endsWith("@example.com") &&
      !email.endsWith("@localhost")
    ) {
      addIssue(path, lineNumber, "contains a personal or non-example email");
    }
  }
}

for (const relativePath of candidatePaths) {
  const fileName = basename(relativePath);
  if (
    !allowedEnvironmentFiles.has(fileName) &&
    sensitiveFileNames.some((pattern) => pattern.test(fileName))
  ) {
    addIssue(relativePath, 1, "uses a sensitive filename");
    continue;
  }

  const absolutePath = resolve(repositoryRoot, relativePath);
  let metadata;
  try {
    metadata = lstatSync(absolutePath);
  } catch {
    continue;
  }

  if (metadata.isSymbolicLink()) {
    inspectText(relativePath, readlinkSync(absolutePath));
    continue;
  }
  if (!metadata.isFile() || metadata.size > 2 * 1024 * 1024) {
    continue;
  }

  const content = readFileSync(absolutePath);
  if (content.subarray(0, 8192).includes(0)) {
    continue;
  }
  inspectText(relativePath, content.toString("utf8"));
}

const identityOutput = execFileSync(
  "git",
  ["log", "--all", "--format=%H%x00%ae%x00%ce%x00"],
  { cwd: repositoryRoot, encoding: "utf8" },
);
const identityFields = identityOutput
  .split("\0")
  .map((field) => field.trim())
  .filter(Boolean);
for (let index = 0; index + 2 < identityFields.length; index += 3) {
  const commit = identityFields[index];
  const emails = new Set([
    identityFields[index + 1].toLowerCase(),
    identityFields[index + 2].toLowerCase(),
  ]);
  for (const email of emails) {
    if (!email.endsWith("@users.noreply.github.com")) {
      addIssue(
        `git:${commit.slice(0, 12)}`,
        1,
        "history exposes a non-noreply author or committer email",
      );
    }
  }
}

if (issues.length > 0) {
  console.error("Public-repository safety check failed:");
  for (const issue of [...new Set(issues)].sort()) {
    console.error(`- ${issue}`);
  }
  process.exit(1);
}

console.log(
  `Public-repository safety check passed (${candidatePaths.length} push candidates).`,
);
