#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function usage() {
  console.error(
    'Usage: node scripts/prepare-updater-feed.mjs --dist <dir> --base-url <url> [--check]'
  );
}

function parseArgs(argv) {
  const args = { check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') {
      args.check = true;
    } else if (arg === '--dist') {
      args.dist = argv[++i];
    } else if (arg === '--base-url') {
      args.baseUrl = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.dist || !args.baseUrl) {
    usage();
    throw new Error('--dist and --base-url are required');
  }
  return args;
}

function readField(contents, field) {
  const match = contents.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  if (!match) throw new Error(`latest-mac.yml is missing ${field}`);
  return match[1].trim();
}

function parseFiles(contents) {
  const files = [];
  const filePattern = /-\s+url:\s*(.+)\n\s+sha512:\s*(.+)\n\s+size:\s*(\d+)/g;
  let match;
  while ((match = filePattern.exec(contents)) !== null) {
    files.push({
      url: match[1].trim(),
      sha512: match[2].trim(),
      size: Number(match[3]),
    });
  }
  if (files.length === 0) throw new Error('latest-mac.yml does not contain any files');
  return files;
}

function artifactNameFromUrl(url) {
  const parsed = new URL(url, 'https://example.invalid/');
  const name = path.posix.basename(parsed.pathname);
  if (!name) throw new Error(`Could not determine artifact name from URL: ${url}`);
  return name;
}

function sha512Base64(filePath) {
  return crypto.createHash('sha512').update(fs.readFileSync(filePath)).digest('base64');
}

function artifactInfo(distDir, name) {
  const filePath = path.join(distDir, name);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`${filePath} is not a file`);
  return {
    name,
    sha512: sha512Base64(filePath),
    size: stat.size,
  };
}

function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, '');
}

function buildYaml({ version, releaseDate, files, baseUrl }) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const zip = files.find((file) => file.name.endsWith('.zip'));
  if (!zip) throw new Error('latest-mac.yml must include a .zip artifact for mac auto-update');

  const lines = [`version: ${version}`, 'files:'];
  for (const file of files) {
    lines.push(`  - url: ${normalizedBaseUrl}/${file.name}`);
    lines.push(`    sha512: ${file.sha512}`);
    lines.push(`    size: ${file.size}`);
  }
  lines.push(`path: ${zip.name}`);
  lines.push(`sha512: ${zip.sha512}`);
  lines.push(`releaseDate: ${releaseDate}`);
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const distDir = path.resolve(args.dist);
  const ymlPath = path.join(distDir, 'latest-mac.yml');
  const current = fs.readFileSync(ymlPath, 'utf8');
  const version = readField(current, 'version');
  const releaseDate = readField(current, 'releaseDate');
  const parsedFiles = parseFiles(current);
  const files = parsedFiles.map((file) => artifactInfo(distDir, artifactNameFromUrl(file.url)));
  const next = buildYaml({ version, releaseDate, files, baseUrl: args.baseUrl });

  if (args.check) {
    if (current !== next) {
      throw new Error(
        'latest-mac.yml does not match the local release artifacts. Run prepare-updater-feed.mjs before publishing.'
      );
    }
    console.log('latest-mac.yml matches local release artifacts.');
    return;
  }

  fs.writeFileSync(ymlPath, next);
  console.log(
    `Updated ${path.relative(process.cwd(), ymlPath)} for ${normalizeBaseUrl(args.baseUrl)}`
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
