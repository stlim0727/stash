import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cruise, format, getAvailableTranspilers } from 'dependency-cruiser';
import extractTSConfig from 'dependency-cruiser/config-utl/extract-ts-config';
import { architectureConfig, PLATFORMS } from './dependency-cruiser.config.mjs';

export async function analyzeArchitecture(platform, options = {}) {
  const sourceRoot = options.sourceRoot ?? 'apps/mobile/src';
  if (!getAvailableTranspilers().some((parser) => parser.name === 'typescript' && parser.available)) {
    throw new Error('dependency-cruiser requires the root TypeScript dependency; run pnpm install --frozen-lockfile.');
  }
  const config = architectureConfig(platform, options);
  // Production follows the app's paths and compiler options, including assets.
  // Fixture roots use the same @/ convention without loading the app project.
  const tsConfigPath = options.tsConfigPath ? resolve(options.tsConfigPath)
    : options.sourceRoot ? undefined : resolve('apps/mobile/tsconfig.json');
  const tsConfig = tsConfigPath ? extractTSConfig(tsConfigPath) : undefined;
  const aliases = tsConfig ? Object.fromEntries(
    Object.entries(tsConfig.options.paths ?? {})
      .sort(([a], [b]) => b.length - a.length)
      .map(([pattern, targets]) => {
        if (pattern.includes('*') && !pattern.endsWith('/*')) {
          throw new Error(`Unsupported architecture alias pattern: ${pattern}`);
        }
        return [pattern.replace(/\/\*$/, ''), targets.map((target) =>
          resolve(tsConfig.options.baseUrl ?? tsConfig.options.pathsBasePath ?? dirname(tsConfigPath), target.replace(/\/\*$/, '')))];
      }),
  ) : { '@': resolve(sourceRoot) };
  const result = await cruise([sourceRoot], {
    ...config.options,
    knownViolations: options.knownViolations ?? [],
    ignoreKnown: true,
    validate: true,
    ruleSet: config,
    outputType: 'json',
  }, { alias: aliases, bustTheCache: true }, { tsConfig });
  return JSON.parse(result.output);
}

async function main() {
  const report = process.argv.includes('--report');
  const baseline = JSON.parse(readFileSync(new URL('./dependency-architecture-baseline.json', import.meta.url), 'utf8'));
  const reportDir = '.artifacts/architecture';
  if (report) mkdirSync(reportDir, { recursive: true });
  const rows = [];
  let errors = 0;
  for (const platform of PLATFORMS) {
    for (const runtimeOnly of [false, true]) {
      const result = await analyzeArchitecture(platform, { runtimeOnly, knownViolations: runtimeOnly && platform !== 'web' ? baseline : [] });
      const lane = runtimeOnly ? 'runtime' : 'contracts';
      errors += result.summary.error;
      const modules = result.modules.filter((module) => module.source.startsWith('apps/mobile/src/'));
      console.log(`${platform}/${lane}: ${modules.length} app modules, ${result.summary.error} errors, ${result.summary.ignore} known violations`);
      for (const violation of result.summary.violations) {
        console.error(`  [${violation.rule.severity}] ${violation.rule.name}: ${violation.from} -> ${violation.to}`);
      }
      rows.push(`| ${platform} | ${lane} | ${modules.length} | ${result.summary.error} | ${result.summary.ignore} |`);
      if (report) {
        writeFileSync(`${reportDir}/${platform}-${lane}.json`, JSON.stringify(result, null, 2) + '\n');
        const graph = await format(result, {
          outputType: 'mermaid', includeOnly: '^apps/mobile/src/', collapse: '^apps/mobile/src/[^/]+',
        });
        writeFileSync(`${reportDir}/${platform}-${lane}.mmd`, graph.output + '\n');
      }
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      '### Dependency-cruiser architecture checks', '',
      '| Platform | Graph | App modules | Errors | Known |', '| --- | --- | ---: | ---: | ---: |', ...rows, '',
      'Contract checks include type imports; cycle checks use runtime imports only.', '',
    ].join('\n'));
  }
  if (errors) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
